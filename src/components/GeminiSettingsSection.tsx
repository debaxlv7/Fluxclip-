import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  Key,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Trash2,
  Cpu,
  RefreshCw,
} from 'lucide-react';

export type GeminiConnectionStatus =
  | 'not_configured'
  | 'testing'
  | 'connected'
  | 'invalid_key'
  | 'quota_exceeded'
  | 'connection_failed';

export interface SupportedModel {
  id: string;
  name: string;
  description: string;
}

interface GeminiSettingsResponse {
  configured: boolean;
  maskedKey: string;
  model: string;
  supportedModels: SupportedModel[];
  status: GeminiConnectionStatus;
  statusMessage: string;
  lastTestedAt?: number;
}

interface GeminiSettingsSectionProps {
  onNotify?: (message: string) => void;
}

export const GeminiSettingsSection: React.FC<GeminiSettingsSectionProps> = ({ onNotify }) => {
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [showKey, setShowKey] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>('gemini-3.8-flash');
  const [supportedModels, setSupportedModels] = useState<SupportedModel[]>([
    {
      id: 'gemini-3.8-flash',
      name: 'Gemini 3.8 Flash (Recommended)',
      description: 'High-speed multimodal intelligence with automatic high-demand failover',
    },
    {
      id: 'gemini-3.6-flash',
      name: 'Gemini 3.6 Flash (High Availability)',
      description: 'Low-latency high-availability model for fast transcript analysis',
    },
    {
      id: 'gemini-3.5-flash',
      name: 'Gemini 3.5 Flash (Balanced)',
      description: 'Reliable structured JSON hook detection for long-form videos',
    },
    {
      id: 'gemini-3.1-flash-lite',
      name: 'Gemini 3.1 Flash Lite',
      description: 'Ultra-lightweight low-latency transcript analysis',
    },
    {
      id: 'gemini-4-argon',
      name: 'Gemini 4 Argon',
      description: 'Deep reasoning for complex long-form video podcasts',
    },
  ]);
  const [isConfigured, setIsConfigured] = useState<boolean>(false);
  const [maskedKey, setMaskedKey] = useState<string>('');
  const [status, setStatus] = useState<GeminiConnectionStatus>('not_configured');
  const [statusMessage, setStatusMessage] = useState<string>('Not configured');
  const [lastTestedAt, setLastTestedAt] = useState<number | undefined>(undefined);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isTesting, setIsTesting] = useState<boolean>(false);
  const [isClearing, setIsClearing] = useState<boolean>(false);

  // Fetch settings from server on mount
  useEffect(() => {
    let isMounted = true;
    async function fetchSettings() {
      try {
        setIsLoading(true);
        const res = await fetch('/api/settings/gemini');
        if (res.ok) {
          const data: GeminiSettingsResponse = await res.json();
          if (isMounted) {
            setIsConfigured(data.configured);
            setMaskedKey(data.maskedKey || '');
            setSelectedModel(data.model || 'gemini-3.8-flash');
            if (data.supportedModels?.length) {
              setSupportedModels(data.supportedModels);
            }
            setStatus(data.status || 'not_configured');
            setStatusMessage(data.statusMessage || '');
            setLastTestedAt(data.lastTestedAt);
          }
        }
      } catch {
        if (isMounted) {
          setStatus('connection_failed');
          setStatusMessage('Could not connect to settings service.');
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    fetchSettings();
    return () => {
      isMounted = false;
    };
  }, []);

  // Save API Key and Model
  const handleSave = async () => {
    const keyToSave = apiKeyInput.trim();
    if (!keyToSave && !isConfigured) {
      onNotify?.('Please enter an API key to save.');
      return;
    }

    try {
      setIsSaving(true);
      const res = await fetch('/api/settings/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: keyToSave || undefined,
          model: selectedModel,
        }),
      });

      if (res.ok) {
        const data: GeminiSettingsResponse = await res.json();
        setIsConfigured(data.configured);
        setMaskedKey(data.maskedKey);
        setSelectedModel(data.model);
        setStatus(data.status);
        setStatusMessage(data.statusMessage);
        setApiKeyInput('');
        onNotify?.('Gemini API settings saved securely.');
      } else {
        onNotify?.('Failed to save Gemini settings.');
      }
    } catch {
      onNotify?.('Network error saving settings.');
    } finally {
      setIsSaving(false);
    }
  };

  // Test Connection
  const handleTest = async () => {
    const keyToTest = apiKeyInput.trim();
    if (!keyToTest && !isConfigured) {
      onNotify?.('Please enter or save an API key to test.');
      return;
    }

    try {
      setIsTesting(true);
      setStatus('testing');
      setStatusMessage('Testing connection to Gemini API...');

      const res = await fetch('/api/settings/gemini/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: keyToTest || undefined,
          model: selectedModel,
        }),
      });

      const data = await res.json();
      setStatus(data.status || 'connection_failed');
      setStatusMessage(data.statusMessage || (data.success ? 'Connected' : 'Connection failed'));
      if (data.success) {
        setLastTestedAt(Date.now());
        onNotify?.('Google Gemini API connected successfully!');
      } else {
        onNotify?.(data.statusMessage || 'Gemini connection test failed.');
      }
    } catch {
      setStatus('connection_failed');
      setStatusMessage('Network timeout testing connection.');
      onNotify?.('Connection test timed out.');
    } finally {
      setIsTesting(false);
    }
  };

  // Clear API Key
  const handleClear = async () => {
    if (!confirm('Clear the saved Gemini API key from the server vault?')) return;

    try {
      setIsClearing(true);
      const res = await fetch('/api/settings/gemini', { method: 'DELETE' });
      if (res.ok) {
        setIsConfigured(false);
        setMaskedKey('');
        setApiKeyInput('');
        setStatus('not_configured');
        setStatusMessage('Gemini API key cleared.');
        setLastTestedAt(undefined);
        onNotify?.('Gemini API key deleted from vault.');
      }
    } catch {
      onNotify?.('Failed to clear Gemini API key.');
    } finally {
      setIsClearing(false);
    }
  };

  // Status Badge Rendering
  const renderStatusBadge = () => {
    switch (status) {
      case 'connected':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 border border-emerald-200">
            <CheckCircle2 className="h-3 w-3 text-emerald-600" />
            Connected
          </span>
        );
      case 'testing':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 border border-amber-200">
            <Loader2 className="h-3 w-3 animate-spin text-amber-600" />
            Testing...
          </span>
        );
      case 'invalid_key':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700 border border-rose-200">
            <AlertCircle className="h-3 w-3 text-rose-600" />
            Invalid API Key
          </span>
        );
      case 'quota_exceeded':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800 border border-amber-200">
            <AlertCircle className="h-3 w-3 text-amber-700" />
            Quota Exceeded
          </span>
        );
      case 'connection_failed':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700 border border-rose-200">
            <AlertCircle className="h-3 w-3 text-rose-600" />
            Connection Failed
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#EFE0DA] px-2.5 py-0.5 text-[11px] font-medium text-[#7D6661]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#7D6661]" />
            Not Configured
          </span>
        );
    }
  };

  return (
    <div className="rounded-2xl border border-[#ECD7CF] bg-[#FAF0EC] p-3.5 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#F4DDD5] text-[#C84335]">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <h4 className="font-semibold text-[#2B1E1C] text-xs">Google Gemini Intelligence</h4>
            <p className="text-[10px] text-[#7D6661]">Viral moment &amp; transcript analysis engine</p>
          </div>
        </div>
        {renderStatusBadge()}
      </div>

      {/* Masked Key Banner if already configured */}
      {isConfigured && maskedKey && (
        <div className="flex items-center justify-between rounded-xl bg-[#F4DDD5]/60 px-3 py-1.5 text-[11px] text-[#5A4540]">
          <div className="flex items-center gap-1.5">
            <Key className="h-3.5 w-3.5 text-[#C84335]" />
            <span className="font-mono-tabular font-medium">{maskedKey}</span>
          </div>
          <span className="text-[10px] text-[#7D6661]">Encrypted on server</span>
        </div>
      )}

      {/* API Key Input */}
      <div>
        <label htmlFor="gemini-api-key-input" className="mb-1 block text-[11px] font-semibold text-[#2B1E1C]">
          {isConfigured ? 'Replace Google Gemini API Key' : 'Google Gemini API Key'}
        </label>
        <div className="relative">
          <input
            id="gemini-api-key-input"
            type={showKey ? 'text' : 'password'}
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder={isConfigured ? 'Enter new API key to replace...' : 'AIzaSy...'}
            disabled={isLoading || isSaving}
            className="w-full rounded-xl border border-[#ECD7CF] bg-white px-3 py-2 pr-9 text-xs font-mono-tabular text-[#2B1E1C] placeholder-[#A48F89] focus:border-[#C84335] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            tabIndex={-1}
            aria-label={showKey ? 'Hide API key' : 'Show API key'}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#7D6661] hover:text-[#2B1E1C]"
          >
            {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Model Selection */}
      <div>
        <label htmlFor="gemini-model-select" className="mb-1 block text-[11px] font-semibold text-[#2B1E1C]">
          Gemini Intelligence Model
        </label>
        <div className="relative">
          <select
            id="gemini-model-select"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={isLoading || isSaving}
            className="w-full appearance-none rounded-xl border border-[#ECD7CF] bg-white px-3 py-2 pr-8 text-xs font-semibold text-[#2B1E1C] focus:border-[#C84335] focus:outline-none cursor-pointer"
          >
            {supportedModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <Cpu className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#7D6661]" />
        </div>
        <p className="mt-1 text-[10px] text-[#7D6661]">
          {supportedModels.find((m) => m.id === selectedModel)?.description || 'Selected Gemini model for viral detection'}
        </p>
      </div>

      {/* Status Message Detail */}
      {statusMessage && (
        <div
          className={`rounded-xl px-2.5 py-1.5 text-[11px] leading-tight ${
            status === 'connected'
              ? 'bg-emerald-50 text-emerald-800'
              : status === 'invalid_key' || status === 'connection_failed'
                ? 'bg-rose-50 text-rose-800'
                : status === 'quota_exceeded'
                  ? 'bg-amber-50 text-amber-900'
                  : 'bg-[#F4DDD5]/50 text-[#5A4540]'
          }`}
        >
          <div className="flex items-start gap-1.5">
            <span className="font-medium">{statusMessage}</span>
            {lastTestedAt && status === 'connected' && (
              <span className="text-[10px] text-emerald-600 opacity-80 whitespace-nowrap">
                (Verified {new Date(lastTestedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
              </span>
            )}
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || isTesting || (!apiKeyInput.trim() && !isConfigured)}
          className="flex-1 rounded-xl bg-[#C84335] px-3 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[#B33B2E] transition-colors disabled:opacity-40"
        >
          {isSaving ? (
            <span className="flex items-center justify-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Saving...
            </span>
          ) : (
            'Save Key'
          )}
        </button>

        <button
          type="button"
          onClick={handleTest}
          disabled={isTesting || isSaving || (!apiKeyInput.trim() && !isConfigured)}
          className="flex items-center justify-center gap-1.5 rounded-xl border border-[#ECD7CF] bg-white px-3 py-1.5 text-xs font-semibold text-[#2B1E1C] hover:bg-[#FDF6F3] transition-colors disabled:opacity-40"
        >
          {isTesting ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin text-[#C84335]" />
              Testing...
            </>
          ) : (
            <>
              <RefreshCw className="h-3 w-3 text-[#7D6661]" />
              Test Connection
            </>
          )}
        </button>

        {isConfigured && (
          <button
            type="button"
            onClick={handleClear}
            disabled={isClearing || isSaving || isTesting}
            aria-label="Clear API Key"
            title="Clear API Key"
            className="flex h-8 w-8 items-center justify-center rounded-xl border border-[#ECD7CF] bg-white text-[#7D6661] hover:text-rose-600 hover:border-rose-300 transition-colors disabled:opacity-40"
          >
            {isClearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
};
