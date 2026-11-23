import { detectPlatform, type Platform } from '@/lib/platform';
import type { DocumentFormat, IpcError, ListenerStopReason } from '@/types/domain';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return kb >= 100 ? `${Math.round(kb)} KB` : `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatCatalogFormatLabel(book: {
  format: DocumentFormat | null;
  rawFormat: string;
  extension: string;
}): string {
  const ext = book.extension.trim().toLowerCase();
  if ((book.format === 'txt' || book.format === 'md') && (ext === 'md' || ext === 'markdown')) {
    return 'Markdown';
  }
  if (book.format !== null) return book.format.toUpperCase();
  const raw = book.rawFormat.trim();
  if (raw.length > 0) return raw.toUpperCase();
  return ext.length > 0 ? ext.toUpperCase() : 'UNKNOWN';
}

export interface ShareStopSummary {
  tone: 'warning' | 'info';
  badge: string;
  message: string;
}

export function describeShareStopReason(
  reason: ListenerStopReason,
  errorCode?: string | null,
): ShareStopSummary {
  if (reason === 'networkChanged' || errorCode === 'lan_network_changed') {
    return {
      tone: 'warning',
      badge: 'Needs attention',
      message:
        'Your local network changed, so sharing stopped. Check your connection and start sharing again.',
    };
  }
  switch (reason) {
    case 'codeExpired':
      return {
        tone: 'info',
        badge: 'Stopped',
        message: 'The pairing code expired before another device connected.',
      };
    case 'idleTimeout':
      return {
        tone: 'info',
        badge: 'Stopped',
        message: 'Sharing stopped after 10 minutes of inactivity.',
      };
    case 'sessionEnded':
      return {
        tone: 'info',
        badge: 'Stopped',
        message: 'The connected device finished and disconnected.',
      };
    case 'stoppedByUser':
    case 'shutdown':
      return {
        tone: 'info',
        badge: 'Stopped',
        message: 'Sharing stopped.',
      };
  }
}

export interface LanErrorPresentation {
  title: string;
  detail: string;
  hints: readonly string[];
  canRetry: boolean;
}

export function describeLanError(
  error: IpcError,
  platform: Platform = detectPlatform(),
): LanErrorPresentation {
  switch (error.code) {
    case 'lan_unreachable':
      return {
        title: 'Could not reach the source device',
        detail: error.message,
        hints:
          platform === 'mac'
            ? [
                'Check Local Network access for SynapseRead in System Settings → Privacy & Security → Local Network on this Mac.',
                'Check the firewall on the source device (allow incoming connections, and make sure "Block all incoming connections" is off).',
                'Verify the IP address and port match what is shown on the source device.',
                'Make sure both devices are on the same local Wi-Fi or Ethernet subnet (not a guest network with client isolation or a separate VLAN).',
              ]
            : [
                'Check the firewall on the source device to make sure incoming local connections to SynapseRead are allowed.',
                'Verify the IP address and port match what is shown on the source device.',
                'Make sure both devices are on the same local Wi-Fi or Ethernet subnet (not a guest network with client isolation or a separate VLAN).',
              ],
        canRetry: true,
      };
    case 'lan_auth_invalid':
      return {
        title: 'Incorrect pairing code',
        detail: error.message,
        hints: [
          'Check the 6-digit code shown on the source device. After 5 incorrect attempts, the code locks until regenerated.',
        ],
        canRetry: true,
      };
    case 'lan_auth_expired':
      return {
        title: 'Pairing session expired',
        detail: error.message,
        hints: [
          'The pairing code or session is no longer active. Start sharing or regenerate the code on the source device, then reconnect.',
        ],
        canRetry: true,
      };
    case 'lan_attempts_exceeded':
      return {
        title: 'Pairing code locked',
        detail: error.message,
        hints: [
          'Too many incorrect attempts locked the current code. Click "Regenerate code" on the source device and try the new code.',
        ],
        canRetry: true,
      };
    case 'lan_session_busy':
      return {
        title: 'Another device is already connected',
        detail: error.message,
        hints: [
          'Only one device can connect to a sharing session at a time. Wait for it to finish or click Disconnect on the source device.',
        ],
        canRetry: true,
      };
    case 'lan_protocol_incompatible':
      return {
        title: 'Incompatible SynapseRead version',
        detail: error.message,
        hints: ['Update SynapseRead on both devices before syncing over the local network.'],
        canRetry: false,
      };
    case 'lan_source_stopped':
      return {
        title: 'Sharing stopped on the source device',
        detail: error.message,
        hints: ['Start sharing again on the source device, then reconnect with the new code.'],
        canRetry: true,
      };
    case 'lan_address_invalid':
      return {
        title: 'Invalid LAN address',
        detail: error.message,
        hints: [
          'Enter a private IPv4 address from your local network, such as 192.168.1.42 or 192.168.1.42:49319. Hostnames and public internet addresses are not allowed.',
        ],
        canRetry: true,
      };
    case 'lan_address_unavailable':
      return {
        title: 'No eligible local network interface',
        detail: error.message,
        hints: [
          'Connect to a local Wi-Fi or Ethernet network (VPN tunnels and loopback interfaces are excluded), then refresh interfaces.',
        ],
        canRetry: true,
      };
    case 'lan_bind_failed':
      return {
        title: 'Could not start sharing listener',
        detail: error.message,
        hints: ['Make sure the selected local network interface is still connected and try again.'],
        canRetry: true,
      };
    case 'lan_ports_exhausted':
      return {
        title: 'All LAN sync ports are in use',
        detail: error.message,
        hints: [
          'Ports 49319–49328 are currently occupied by other applications. Close the conflicting software or try again.',
        ],
        canRetry: true,
      };
    case 'lan_network_changed':
      return {
        title: 'Local network changed',
        detail: error.message,
        hints: [
          'Your local network connection changed while sharing. Check your Wi-Fi or Ethernet connection and start sharing again.',
        ],
        canRetry: true,
      };
    case 'lan_scope_denied':
      return {
        title: 'Not permitted by source session',
        detail: error.message,
        hints: [
          'The source device did not allow access to this book or reading data in the current session.',
        ],
        canRetry: false,
      };
    case 'lan_transfer_busy':
      return {
        title: 'Another file transfer is already active',
        detail: error.message,
        hints: ['Wait for the current transfer to finish, then try again.'],
        canRetry: true,
      };
    case 'lan_source_changed':
      return {
        title: 'Source file changed',
        detail: error.message,
        hints: [
          'The book on the source device changed after sharing started. Start a fresh sharing session on the source device and reconnect.',
        ],
        canRetry: true,
      };
    case 'lan_size_mismatch':
    case 'lan_hash_mismatch':
      return {
        title: 'Transferred file failed verification',
        detail: error.message,
        hints: [
          'The downloaded file size or SHA-256 checksum did not match the source catalog. Retry the failed item.',
        ],
        canRetry: true,
      };
    case 'lan_payload_too_large':
      return {
        title: 'Response exceeded safe size limit',
        detail: error.message,
        hints: ['The source device sent a response larger than V1 protocol limits allow.'],
        canRetry: false,
      };
    case 'lan_disk_full':
      return {
        title: 'Not enough disk space',
        detail: error.message,
        hints: ['Free up storage space on this device and retry the failed items.'],
        canRetry: true,
      };
    case 'lan_cancelled':
      return {
        title: 'Operation cancelled',
        detail: error.message,
        hints: ['Completed books were kept and any partial download was cleaned up.'],
        canRetry: true,
      };
    case 'lan_position_conflict':
      return {
        title: 'Reading position changed on this device',
        detail: error.message,
        hints: [
          'Compare the updated local reading position before choosing to replace it with the source position.',
        ],
        canRetry: true,
      };
    default:
      return {
        title: 'LAN sync error',
        detail: error.message,
        hints: [],
        canRetry: true,
      };
  }
}
