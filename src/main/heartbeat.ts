import { BrowserWindow } from 'electron';
import type { CoworkStore } from './coworkStore';
import type { CoworkRunner } from './libs/coworkRunner';
import type { IMGatewayManager } from './im/imGatewayManager';
import type { NotifyPlatform } from './scheduledTaskStore';

// --- Constants ---

const HEARTBEAT_OK_TOKEN = 'HEARTBEAT_OK';
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_ACK_MAX_CHARS = 300;
const DEFAULT_PROMPT =
  'Read HEARTBEAT.md if it exists in the working directory. Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.';
const DUPLICATE_SUPPRESS_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_HISTORY = 50;

// --- Types ---

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  prompt: string;
  activeHours?: { start: string; end: string; timezone?: string } | null;
  notifyPlatforms: NotifyPlatform[];
  ackMaxChars: number;
  workingDirectory?: string;
  sessionId?: string;
}

export interface HeartbeatStatus {
  running: boolean;
  lastRunAt: number | null;
  lastResult: 'ok' | 'notified' | 'error' | 'skipped' | null;
  lastError: string | null;
  nextRunAt: number | null;
}

export interface HeartbeatRunResult {
  result: 'ok' | 'notified' | 'error' | 'skipped';
  message?: string;
  error?: string;
}

export interface HeartbeatHistoryEntry {
  timestamp: number;
  result: 'ok' | 'notified' | 'error' | 'skipped';
  message?: string;
  error?: string;
}

interface HeartbeatDeps {
  coworkStore: CoworkStore;
  getCoworkRunner: () => CoworkRunner;
  getIMGatewayManager: () => IMGatewayManager | null;
  getConfig: () => HeartbeatConfig;
  saveConfig: (config: HeartbeatConfig) => void;
  getSkillsPrompt?: () => Promise<string | null>;
}

// --- Default config ---

export function getDefaultHeartbeatConfig(): HeartbeatConfig {
  return {
    enabled: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    prompt: DEFAULT_PROMPT,
    activeHours: null,
    notifyPlatforms: [],
    ackMaxChars: DEFAULT_ACK_MAX_CHARS,
  };
}

// --- HeartbeatRunner ---

export class HeartbeatRunner {
  private deps: HeartbeatDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastRunMs = 0;
  private lastResult: HeartbeatStatus['lastResult'] = null;
  private lastError: string | null = null;
  private lastHeartbeatText = '';
  private lastHeartbeatSentAt = 0;
  private history: HeartbeatHistoryEntry[] = [];

  constructor(deps: HeartbeatDeps) {
    this.deps = deps;
  }

  start(): void {
    const config = this.deps.getConfig();
    if (!config.enabled) return;
    if (this.running) return;
    this.running = true;
    console.log('[HeartbeatRunner] Started');
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('[HeartbeatRunner] Stopped');
  }

  updateConfig(partial: Partial<HeartbeatConfig>): void {
    const current = this.deps.getConfig();
    const merged = { ...current, ...partial };
    this.deps.saveConfig(merged);

    // Restart if enabled state or interval changed
    if (this.running && (!merged.enabled || merged.intervalMs !== current.intervalMs)) {
      this.stop();
    }
    if (merged.enabled && !this.running) {
      this.start();
    }
  }

  getStatus(): HeartbeatStatus {
    const config = this.deps.getConfig();
    return {
      running: this.running,
      lastRunAt: this.lastRunMs || null,
      lastResult: this.lastResult,
      lastError: this.lastError,
      nextRunAt: this.running && this.timer
        ? this.lastRunMs + config.intervalMs
        : null,
    };
  }

  getHistory(): HeartbeatHistoryEntry[] {
    return [...this.history];
  }

  async runOnce(): Promise<HeartbeatRunResult> {
    return this.tick(true);
  }

  // --- Internal ---

  private scheduleNext(): void {
    if (!this.running) return;
    const config = this.deps.getConfig();
    const now = Date.now();
    const elapsed = now - this.lastRunMs;
    const delay = this.lastRunMs === 0
      ? 1000  // First run: 1 second delay
      : Math.max(config.intervalMs - elapsed, 0);

    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick(false).then(() => {
        if (this.running) {
          this.scheduleNext();
        }
      });
    }, delay);
  }

  private async tick(manual: boolean): Promise<HeartbeatRunResult> {
    const config = this.deps.getConfig();

    if (!manual && !config.enabled) {
      return { result: 'skipped', message: 'Heartbeat disabled' };
    }

    // Check active hours
    if (!manual && !this.isWithinActiveHours(config)) {
      const entry: HeartbeatHistoryEntry = {
        timestamp: Date.now(),
        result: 'skipped',
        message: 'Outside active hours',
      };
      this.pushHistory(entry);
      this.lastResult = 'skipped';
      this.lastRunMs = Date.now();
      this.emitStatusChange();
      return { result: 'skipped', message: 'Outside active hours' };
    }

    this.lastRunMs = Date.now();

    try {
      const replyText = await this.runCoworkSession(config);
      const { shouldSkip, text: cleanedText } = this.stripHeartbeatToken(replyText);

      if (shouldSkip) {
        // Agent says nothing needs attention
        const entry: HeartbeatHistoryEntry = {
          timestamp: Date.now(),
          result: 'ok',
        };
        this.pushHistory(entry);
        this.lastResult = 'ok';
        this.lastError = null;
        this.emitStatusChange();
        return { result: 'ok' };
      }

      // Agent found something that needs attention
      const trimmed = cleanedText.slice(0, config.ackMaxChars || DEFAULT_ACK_MAX_CHARS);

      // Check for duplicates
      if (this.isDuplicate(trimmed)) {
        const entry: HeartbeatHistoryEntry = {
          timestamp: Date.now(),
          result: 'ok',
          message: 'Duplicate suppressed',
        };
        this.pushHistory(entry);
        this.lastResult = 'ok';
        this.lastError = null;
        this.emitStatusChange();
        return { result: 'ok', message: 'Duplicate suppressed' };
      }

      // Send IM notifications
      await this.sendNotifications(config, trimmed);

      this.lastHeartbeatText = trimmed;
      this.lastHeartbeatSentAt = Date.now();

      const entry: HeartbeatHistoryEntry = {
        timestamp: Date.now(),
        result: 'notified',
        message: trimmed,
      };
      this.pushHistory(entry);
      this.lastResult = 'notified';
      this.lastError = null;
      this.emitStatusChange();
      return { result: 'notified', message: trimmed };

    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[HeartbeatRunner] Error:', errorMsg);
      const entry: HeartbeatHistoryEntry = {
        timestamp: Date.now(),
        result: 'error',
        error: errorMsg,
      };
      this.pushHistory(entry);
      this.lastResult = 'error';
      this.lastError = errorMsg;
      this.emitStatusChange();
      return { result: 'error', error: errorMsg };
    }
  }

  private async runCoworkSession(config: HeartbeatConfig): Promise<string> {
    const coworkConfig = this.deps.coworkStore.getConfig();
    const cwd = config.workingDirectory || coworkConfig.workingDirectory;
    const baseSystemPrompt = coworkConfig.systemPrompt || '';

    let skillsPrompt: string | null = null;
    if (this.deps.getSkillsPrompt) {
      try {
        skillsPrompt = await this.deps.getSkillsPrompt();
      } catch {
        // Ignore skills prompt errors
      }
    }

    const systemPrompt = [skillsPrompt, baseSystemPrompt]
      .filter((p): p is string => Boolean(p?.trim()))
      .join('\n\n');

    const executionMode = coworkConfig.executionMode || 'auto';
    const prompt = config.prompt || DEFAULT_PROMPT;

    // Reuse persistent session or create a new one
    let sessionId = config.sessionId;
    let existingSession = sessionId ? this.deps.coworkStore.getSession(sessionId) : null;

    if (!existingSession) {
      // Create a new persistent heartbeat session
      const session = this.deps.coworkStore.createSession(
        '[Heartbeat] 巡查',
        cwd,
        systemPrompt,
        executionMode,
        [],
        true
      );
      sessionId = session.id;
      existingSession = session;

      // Persist session ID for future ticks
      this.deps.saveConfig({ ...config, sessionId });
    } else {
      // Update cwd in case working directory changed
      this.deps.coworkStore.updateSession(sessionId, { cwd });
    }

    // Record message count before this tick to extract only new replies
    const messageCountBefore = existingSession.messages.length;

    // Update session status and add user message
    this.deps.coworkStore.updateSession(sessionId, { status: 'running' });
    this.deps.coworkStore.addMessage(sessionId, {
      type: 'user',
      content: prompt,
    });

    // Run the session (resumes Claude conversation via stored claudeSessionId)
    const runner = this.deps.getCoworkRunner();
    await runner.startSession(sessionId, prompt, {
      skipInitialUserMessage: true,
      confirmationMode: 'text',
      systemPrompt,
    });

    // Extract only assistant replies from THIS tick
    const completedSession = this.deps.coworkStore.getSession(sessionId);
    if (!completedSession) {
      throw new Error('Session not found after completion');
    }

    const newMessages = completedSession.messages.slice(messageCountBefore);
    const assistantMessages = newMessages.filter(
      (msg) => msg.type === 'assistant' && msg.content && !msg.metadata?.isThinking
    );
    return assistantMessages.map((m) => m.content).join('\n\n');
  }

  private isWithinActiveHours(config: HeartbeatConfig): boolean {
    if (!config.activeHours) return true;

    const { start, end, timezone } = config.activeHours;
    if (!start || !end) return true;

    const now = new Date();
    let hours: number;
    let minutes: number;

    if (timezone) {
      try {
        const formatted = now.toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          timeZone: timezone,
        });
        const [h, m] = formatted.split(':').map(Number);
        hours = h;
        minutes = m;
      } catch {
        hours = now.getHours();
        minutes = now.getMinutes();
      }
    } else {
      hours = now.getHours();
      minutes = now.getMinutes();
    }

    const currentMinutes = hours * 60 + minutes;
    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      // Same day range (e.g., 08:00 - 22:00)
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    } else {
      // Overnight range (e.g., 22:00 - 06:00)
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }
  }

  private stripHeartbeatToken(text: string): { shouldSkip: boolean; text: string } {
    const trimmed = text.trim();
    if (!trimmed) {
      return { shouldSkip: true, text: '' };
    }

    // Check if the entire response is just HEARTBEAT_OK (possibly with whitespace/punctuation)
    const normalized = trimmed.replace(/[.!。！\s]+$/, '');
    if (normalized === HEARTBEAT_OK_TOKEN) {
      return { shouldSkip: true, text: '' };
    }

    // Check if text contains the token - remove it and check if anything meaningful remains
    if (trimmed.includes(HEARTBEAT_OK_TOKEN)) {
      const cleaned = trimmed.replace(HEARTBEAT_OK_TOKEN, '').trim();
      if (!cleaned || cleaned.length < 10) {
        return { shouldSkip: true, text: '' };
      }
      return { shouldSkip: false, text: cleaned };
    }

    return { shouldSkip: false, text: trimmed };
  }

  private isDuplicate(text: string): boolean {
    if (!this.lastHeartbeatText) return false;
    const now = Date.now();
    if (now - this.lastHeartbeatSentAt > DUPLICATE_SUPPRESS_MS) return false;
    return text === this.lastHeartbeatText;
  }

  private async sendNotifications(config: HeartbeatConfig, message: string): Promise<void> {
    const imManager = this.deps.getIMGatewayManager();
    if (!imManager) return;

    const platforms = config.notifyPlatforms;
    if (!platforms || platforms.length === 0) return;

    const fullMessage = `💓 Heartbeat 巡查通知\n\n${message}`;

    for (const platform of platforms) {
      try {
        await imManager.sendNotificationWithMedia(platform, fullMessage);
        console.log(`[HeartbeatRunner] Notification sent via ${platform}`);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[HeartbeatRunner] Failed to send notification via ${platform}: ${errMsg}`);
      }
    }
  }

  private pushHistory(entry: HeartbeatHistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }

  private emitStatusChange(): void {
    const status = this.getStatus();
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('heartbeat:statusChange', status);
      }
    });
  }
}
