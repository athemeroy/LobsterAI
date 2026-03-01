import React, { useState, useEffect, useCallback } from 'react';
import { i18nService } from '../services/i18n';

type HeartbeatPlatform = 'dingtalk' | 'feishu' | 'telegram' | 'discord' | 'nim';

interface LocalHeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  prompt: string;
  activeHours?: { start: string; end: string; timezone?: string } | null;
  notifyPlatforms: HeartbeatPlatform[];
  ackMaxChars: number;
  workingDirectory?: string;
}

interface LocalHeartbeatStatus {
  running: boolean;
  lastRunAt: number | null;
  lastResult: 'ok' | 'notified' | 'error' | 'skipped' | null;
  lastError: string | null;
  nextRunAt: number | null;
}

interface LocalHeartbeatHistoryEntry {
  timestamp: number;
  result: 'ok' | 'notified' | 'error' | 'skipped';
  message?: string;
  error?: string;
}

const INTERVAL_OPTIONS = [
  { value: 15 * 60 * 1000, labelKey: 'heartbeatInterval15m' },
  { value: 30 * 60 * 1000, labelKey: 'heartbeatInterval30m' },
  { value: 60 * 60 * 1000, labelKey: 'heartbeatInterval1h' },
  { value: 2 * 60 * 60 * 1000, labelKey: 'heartbeatInterval2h' },
] as const;

const PLATFORM_OPTIONS = [
  { value: 'dingtalk', label: 'DingTalk' },
  { value: 'feishu', label: 'Feishu' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'discord', label: 'Discord' },
  { value: 'nim', label: 'NIM' },
] as const;

const HeartbeatSettings: React.FC = () => {
  const [config, setConfig] = useState<LocalHeartbeatConfig | null>(null);
  const [status, setStatus] = useState<LocalHeartbeatStatus | null>(null);
  const [history, setHistory] = useState<LocalHeartbeatHistoryEntry[]>([]);
  const [runningNow, setRunningNow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fileExists, setFileExists] = useState<boolean | null>(null);
  const [fileOpening, setFileOpening] = useState(false);
  const [fileNoWorkDir, setFileNoWorkDir] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [configRes, statusRes, historyRes, fileRes] = await Promise.all([
        window.electron.heartbeat.getConfig(),
        window.electron.heartbeat.getStatus(),
        window.electron.heartbeat.getHistory(),
        window.electron.heartbeat.checkFile(),
      ]);
      if (configRes.success && configRes.config) setConfig(configRes.config);
      if (statusRes.success && statusRes.status) setStatus(statusRes.status);
      if (historyRes.success && historyRes.history) setHistory(historyRes.history);
      if (fileRes.success) setFileExists(fileRes.exists);
    } catch (err) {
      console.error('Failed to load heartbeat data:', err);
    }
  }, []);

  useEffect(() => {
    loadData();
    const unsubscribe = window.electron.heartbeat.onStatusChange((newStatus) => {
      setStatus(newStatus);
      // Refresh history on status change
      window.electron.heartbeat.getHistory().then((res) => {
        if (res.success && res.history) setHistory(res.history);
      });
    });
    return () => unsubscribe();
  }, [loadData]);

  const updateConfig = async (partial: Partial<LocalHeartbeatConfig>) => {
    setSaving(true);
    try {
      await window.electron.heartbeat.setConfig(partial);
      const res = await window.electron.heartbeat.getConfig();
      if (res.success && res.config) setConfig(res.config);
      const statusRes = await window.electron.heartbeat.getStatus();
      if (statusRes.success && statusRes.status) setStatus(statusRes.status);
    } catch (err) {
      console.error('Failed to update heartbeat config:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleOpenOrCreateFile = async () => {
    setFileOpening(true);
    setFileNoWorkDir(false);
    try {
      const res = await window.electron.heartbeat.openOrCreateFile();
      if (!res.success && res.error === 'Working directory not set') {
        setFileNoWorkDir(true);
      } else if (res.success) {
        setFileExists(true);
      }
    } catch (err) {
      console.error('Failed to open/create HEARTBEAT.md:', err);
    } finally {
      setFileOpening(false);
    }
  };

  const handleRunNow = async () => {
    setRunningNow(true);
    try {
      await window.electron.heartbeat.runNow();
      await loadData();
    } catch (err) {
      console.error('Failed to run heartbeat:', err);
    } finally {
      setRunningNow(false);
    }
  };

  const handleTogglePlatform = (platform: HeartbeatPlatform) => {
    if (!config) return;
    const current = config.notifyPlatforms || [];
    const next = current.includes(platform)
      ? current.filter((p) => p !== platform)
      : [...current, platform];
    updateConfig({ notifyPlatforms: next });
  };

  if (!config) {
    return <div className="text-sm dark:text-claude-darkSubtext text-claude-subtext">Loading...</div>;
  }

  const resultLabel = (result: string | null) => {
    switch (result) {
      case 'ok': return i18nService.t('heartbeatResultOk');
      case 'notified': return i18nService.t('heartbeatResultNotified');
      case 'error': return i18nService.t('heartbeatResultError');
      case 'skipped': return i18nService.t('heartbeatResultSkipped');
      default: return '-';
    }
  };

  const resultColor = (result: string | null) => {
    switch (result) {
      case 'ok': return 'text-green-500';
      case 'notified': return 'text-blue-500';
      case 'error': return 'text-red-500';
      case 'skipped': return 'text-yellow-500';
      default: return 'dark:text-claude-darkSubtext text-claude-subtext';
    }
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return '-';
    return new Date(ts).toLocaleString();
  };

  return (
    <div className="space-y-6">
      {/* HEARTBEAT.md file section */}
      <div className="p-3 rounded-lg border dark:border-claude-darkBorder border-claude-border space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('heartbeatFileSection')}
          </h4>
          {fileExists !== null && (
            <span className={`text-xs font-medium ${fileExists ? 'text-green-500' : 'dark:text-claude-darkSubtext text-claude-subtext'}`}>
              {fileExists ? i18nService.t('heartbeatFileExists') : i18nService.t('heartbeatFileNotFound')}
            </span>
          )}
        </div>
        <p className="text-xs dark:text-claude-darkSubtext text-claude-subtext">
          {i18nService.t('heartbeatFileHint')}
        </p>
        <div className="rounded bg-gray-100 dark:bg-claude-darkBg/70 px-3 py-2 text-xs font-mono dark:text-claude-darkSubtext text-claude-subtext leading-relaxed">
          {'# Heartbeat Tasks'}<br />
          {'- Check inbox for urgent emails'}<br />
          {'- Check GitHub issues filed in the past 30 min'}<br />
          {'- If CPU > 80%, alert me'}
        </div>
        {fileNoWorkDir && (
          <p className="text-xs text-yellow-500">{i18nService.t('heartbeatFileNoWorkDir')}</p>
        )}
        <button
          onClick={handleOpenOrCreateFile}
          disabled={fileOpening}
          className="w-full px-3 py-1.5 text-xs rounded-md border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:border-claude-primary hover:text-claude-primary transition-colors disabled:opacity-50"
        >
          {fileExists ? i18nService.t('heartbeatFileOpen') : i18nService.t('heartbeatFileCreate')}
        </button>
      </div>

      {/* Enable toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('heartbeatEnabled')}
          </h4>
          <p className="text-xs dark:text-claude-darkSubtext text-claude-subtext mt-0.5">
            {i18nService.t('heartbeatEnabledHint')}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={config.enabled}
          onClick={() => updateConfig({ enabled: !config.enabled })}
          disabled={saving}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none ${
            config.enabled ? 'bg-claude-primary' : 'bg-gray-300 dark:bg-gray-600'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform duration-200 ${
              config.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
            }`}
          />
        </button>
      </div>

      {/* Working directory */}
      <div>
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
          {i18nService.t('heartbeatWorkingDir')}
        </h4>
        <p className="text-xs dark:text-claude-darkSubtext text-claude-subtext mb-2">
          {i18nService.t('heartbeatWorkingDirHint')}
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={config.workingDirectory || ''}
            readOnly
            placeholder={i18nService.t('heartbeatWorkingDirPlaceholder')}
            className="flex-1 text-sm rounded-md border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-white px-2 py-1 dark:text-claude-darkSubtext text-claude-subtext focus:outline-none truncate"
          />
          <button
            onClick={async () => {
              const res = await window.electron.dialog.selectDirectory();
              if (res.success && res.path) updateConfig({ workingDirectory: res.path });
            }}
            disabled={saving}
            className="shrink-0 text-xs px-2 py-1 rounded-md border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkSubtext text-claude-subtext hover:border-claude-primary hover:text-claude-primary transition-colors disabled:opacity-50"
          >
            {i18nService.t('heartbeatWorkingDirBrowse')}
          </button>
          {config.workingDirectory && (
            <button
              onClick={() => updateConfig({ workingDirectory: undefined })}
              disabled={saving}
              className="shrink-0 text-xs text-red-500 hover:text-red-600 disabled:opacity-50"
            >
              &times;
            </button>
          )}
        </div>
      </div>

      {/* Interval */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
          {i18nService.t('heartbeatInterval')}
        </h4>
        <select
          value={config.intervalMs}
          onChange={(e) => updateConfig({ intervalMs: Number(e.target.value) })}
          disabled={saving}
          className="w-[140px] text-sm rounded-md border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-white px-2 py-1 dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-1 focus:ring-claude-primary"
        >
          {INTERVAL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {i18nService.t(opt.labelKey)}
            </option>
          ))}
        </select>
      </div>

      {/* Active hours */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {i18nService.t('heartbeatActiveHours')}
            </h4>
            <p className="text-xs dark:text-claude-darkSubtext text-claude-subtext mt-0.5">
              {i18nService.t('heartbeatActiveHoursHint')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="time"
            value={config.activeHours?.start || ''}
            onChange={(e) => updateConfig({
              activeHours: {
                start: e.target.value,
                end: config.activeHours?.end || '22:00',
                timezone: config.activeHours?.timezone,
              }
            })}
            disabled={saving}
            className="text-sm rounded-md border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-white px-2 py-1 dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-1 focus:ring-claude-primary"
          />
          <span className="text-sm dark:text-claude-darkSubtext text-claude-subtext">-</span>
          <input
            type="time"
            value={config.activeHours?.end || ''}
            onChange={(e) => updateConfig({
              activeHours: {
                start: config.activeHours?.start || '08:00',
                end: e.target.value,
                timezone: config.activeHours?.timezone,
              }
            })}
            disabled={saving}
            className="text-sm rounded-md border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-white px-2 py-1 dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-1 focus:ring-claude-primary"
          />
          {config.activeHours && (
            <button
              onClick={() => updateConfig({ activeHours: null })}
              className="text-xs text-red-500 hover:text-red-600"
            >
              &times;
            </button>
          )}
        </div>
      </div>

      {/* Notify platforms */}
      <div>
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
          {i18nService.t('heartbeatNotifyPlatforms')}
        </h4>
        <p className="text-xs dark:text-claude-darkSubtext text-claude-subtext mb-2">
          {i18nService.t('heartbeatNotifyPlatformsHint')}
        </p>
        <div className="flex flex-wrap gap-2">
          {PLATFORM_OPTIONS.map((opt) => {
            const selected = (config.notifyPlatforms || []).includes(opt.value);
            return (
              <button
                key={opt.value}
                onClick={() => handleTogglePlatform(opt.value)}
                disabled={saving}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  selected
                    ? 'bg-claude-primary text-white border-claude-primary'
                    : 'dark:border-claude-darkBorder border-claude-border dark:text-claude-darkSubtext text-claude-subtext hover:border-claude-primary'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Prompt */}
      <div>
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
          {i18nService.t('heartbeatPrompt')}
        </h4>
        <p className="text-xs dark:text-claude-darkSubtext text-claude-subtext mb-2">
          {i18nService.t('heartbeatPromptHint')}
        </p>
        <textarea
          value={config.prompt}
          onChange={(e) => setConfig({ ...config, prompt: e.target.value })}
          onBlur={() => updateConfig({ prompt: config.prompt })}
          disabled={saving}
          rows={3}
          className="w-full text-sm rounded-md border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-white px-3 py-2 dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-1 focus:ring-claude-primary resize-none"
        />
      </div>

      {/* Status & Run Now */}
      <div className="p-3 rounded-lg dark:bg-claude-darkBg/50 bg-gray-50 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('heartbeatStatus')}
          </h4>
          <span className={`text-xs font-medium ${status?.running ? 'text-green-500' : 'dark:text-claude-darkSubtext text-claude-subtext'}`}>
            {status?.running ? i18nService.t('heartbeatStatusRunning') : i18nService.t('heartbeatStatusStopped')}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs dark:text-claude-darkSubtext text-claude-subtext">
          <span>{i18nService.t('heartbeatLastRun')}</span>
          <span>{formatTime(status?.lastRunAt ?? null)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="dark:text-claude-darkSubtext text-claude-subtext">{i18nService.t('heartbeatLastResult')}</span>
          <span className={resultColor(status?.lastResult ?? null)}>
            {resultLabel(status?.lastResult ?? null)}
          </span>
        </div>
        {status?.lastError && (
          <p className="text-xs text-red-500 mt-1 break-all">{status.lastError}</p>
        )}
        <button
          onClick={handleRunNow}
          disabled={runningNow}
          className="mt-2 w-full px-3 py-1.5 text-sm rounded-md bg-claude-primary text-white hover:bg-claude-primary/90 disabled:opacity-50 transition-colors"
        >
          {runningNow ? i18nService.t('heartbeatRunning') : i18nService.t('heartbeatRunNow')}
        </button>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div>
          <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-2">
            {i18nService.t('heartbeatHistory')}
          </h4>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {[...history].reverse().slice(0, 20).map((entry, idx) => (
              <div key={idx} className="flex items-center justify-between text-xs py-1 px-2 rounded dark:bg-claude-darkBg/30 bg-gray-50">
                <span className="dark:text-claude-darkSubtext text-claude-subtext">
                  {formatTime(entry.timestamp)}
                </span>
                <span className={resultColor(entry.result)}>
                  {resultLabel(entry.result)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default HeartbeatSettings;
