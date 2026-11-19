//! Coordinates flushing unsaved Inspector edits before the window closes or the
//! app quits (#117).
//!
//! The first close or exit request is paused briefly while the webview flushes
//! any pending card edits through `update_card` and acknowledges via
//! [`confirm_flush_before_close`]. A bounded timeout guarantees an unloaded or
//! unresponsive webview can never block quitting.

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::error::IpcResult;

pub const BEFORE_CLOSE_EVENT: &str = "synapse://before-close";
pub const FLUSH_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeforeClosePayload {
    pub token: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDecision {
    Proceed,
    AlreadyWaiting,
    StartFlush(u64),
}

#[derive(Default)]
struct Inner {
    next_token: u64,
    in_flight: Option<u64>,
    completed_token: u64,
    allow_close: bool,
    allow_exit: bool,
}

#[derive(Default)]
pub struct CloseFlushCoordinator {
    state: Mutex<Inner>,
    ready: Condvar,
}

impl CloseFlushCoordinator {
    pub fn begin_close(&self) -> CloseDecision {
        let Ok(mut inner) = self.state.lock() else {
            return CloseDecision::Proceed;
        };
        if inner.allow_close || inner.allow_exit {
            return CloseDecision::Proceed;
        }
        if inner.in_flight.is_some() {
            return CloseDecision::AlreadyWaiting;
        }
        inner.next_token += 1;
        let token = inner.next_token;
        inner.in_flight = Some(token);
        CloseDecision::StartFlush(token)
    }

    pub fn begin_exit(&self) -> CloseDecision {
        let Ok(mut inner) = self.state.lock() else {
            return CloseDecision::Proceed;
        };
        if inner.allow_exit {
            return CloseDecision::Proceed;
        }
        if inner.in_flight.is_some() {
            return CloseDecision::AlreadyWaiting;
        }
        inner.next_token += 1;
        let token = inner.next_token;
        inner.in_flight = Some(token);
        CloseDecision::StartFlush(token)
    }

    pub fn confirm(&self, token: u64) {
        let Ok(mut inner) = self.state.lock() else {
            return;
        };
        if token > inner.completed_token {
            inner.completed_token = token;
        }
        if inner.in_flight == Some(token) {
            inner.in_flight = None;
        }
        self.ready.notify_all();
    }

    /// Waits up to `timeout` for [`Self::confirm`] with `token`. Returns `true`
    /// when acknowledged before the deadline.
    pub fn wait_for_flush(&self, token: u64, timeout: Duration) -> bool {
        let Ok(mut inner) = self.state.lock() else {
            return false;
        };
        let deadline = Instant::now() + timeout;
        while inner.completed_token < token {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let Ok((next, result)) = self.ready.wait_timeout(inner, remaining) else {
                return false;
            };
            inner = next;
            if result.timed_out() {
                break;
            }
        }
        let confirmed = inner.completed_token >= token;
        if inner.in_flight == Some(token) {
            inner.in_flight = None;
        }
        confirmed
    }

    pub fn mark_allow_close(&self) {
        if let Ok(mut inner) = self.state.lock() {
            inner.allow_close = true;
        }
    }

    pub fn mark_allow_exit(&self) {
        if let Ok(mut inner) = self.state.lock() {
            inner.allow_exit = true;
            inner.allow_close = true;
        }
    }
}

/// Signals that the webview has finished flushing pending edits before close/quit.
#[tauri::command]
pub fn confirm_flush_before_close(
    token: u64,
    coordinator: State<'_, CloseFlushCoordinator>,
) -> IpcResult<()> {
    coordinator.confirm(token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::thread;

    use super::*;

    #[test]
    fn confirm_unblocks_waiting_flush_and_subsequent_close_proceeds() {
        let coordinator = Arc::new(CloseFlushCoordinator::default());
        let token = match coordinator.begin_close() {
            CloseDecision::StartFlush(token) => token,
            other => panic!("expected StartFlush, got {other:?}"),
        };
        assert_eq!(coordinator.begin_close(), CloseDecision::AlreadyWaiting);

        let worker = Arc::clone(&coordinator);
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(10));
            worker.confirm(token);
        });

        assert!(coordinator.wait_for_flush(token, Duration::from_secs(1)));
        handle.join().unwrap();

        coordinator.mark_allow_close();
        assert_eq!(coordinator.begin_close(), CloseDecision::Proceed);
    }

    #[test]
    fn wait_for_flush_times_out_cleanly_when_unconfirmed() {
        let coordinator = CloseFlushCoordinator::default();
        let token = match coordinator.begin_exit() {
            CloseDecision::StartFlush(token) => token,
            other => panic!("expected StartFlush, got {other:?}"),
        };
        assert!(!coordinator.wait_for_flush(token, Duration::from_millis(15)));
        coordinator.mark_allow_exit();
        assert_eq!(coordinator.begin_exit(), CloseDecision::Proceed);
        assert_eq!(coordinator.begin_close(), CloseDecision::Proceed);
    }
}
