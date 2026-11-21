use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::sync::{Semaphore, broadcast, mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::{Instant, MissedTickBehavior};

use crate::address::{
    InterfaceProvider, Ipv4Subnet, PeerPolicy, PeerRejectReason, select_candidate_interfaces,
};
use crate::bind::BoundListener;
use crate::error::LanError;

/// Default interface-availability poll interval while sharing (ADR 0008).
pub const DEFAULT_INTERFACE_POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Default unpaired pairing-code expiry timeout (ADR 0008: 10 minutes).
pub const DEFAULT_CODE_EXPIRY: Duration = Duration::from_secs(10 * 60);
/// Default paired session idle timeout (ADR 0008: 10 minutes).
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Hard upper bound on concurrent accepted TCP connections (ADR 0008: <= 4).
pub const MAX_CONCURRENT_CONNECTIONS: usize = 4;
/// Default maximum concurrent accepted TCP connections (ADR 0008: <= 4).
pub const DEFAULT_MAX_CONNECTIONS: usize = MAX_CONCURRENT_CONNECTIONS;

const EVENT_CHANNEL_CAPACITY: usize = 32;

/// Monotonic clock abstraction for deterministic timer tests (`T-10`).
pub trait MonotonicClock: Send + Sync {
    fn now(&self) -> Instant;
}

/// Default monotonic clock backed by `tokio::time::Instant`.
///
/// Works seamlessly with `tokio::time::pause()` and `tokio::time::advance(...)`
/// in deterministic async tests.
#[derive(Debug, Default, Clone, Copy)]
pub struct TokioMonotonicClock;

impl MonotonicClock for TokioMonotonicClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// Configuration for a session-scoped [`LanListener`].
#[derive(Debug, Clone, Copy)]
pub struct ListenerConfig {
    pub interface_poll_interval: Duration,
    pub code_expiry: Duration,
    pub idle_timeout: Duration,
    pub max_connections: usize,
    /// When `false`, the bound IP is checked against raw interface presence
    /// rather than LAN candidate rules (used only by loopback tests).
    pub enforce_candidate_interface: bool,
}

impl ListenerConfig {
    /// Returns the effective concurrent connection cap clamped to ADR 0008's
    /// `1..=MAX_CONCURRENT_CONNECTIONS` (`1..=4`) bound.
    pub const fn effective_max_connections(&self) -> usize {
        if self.max_connections < 1 {
            1
        } else if self.max_connections > MAX_CONCURRENT_CONNECTIONS {
            MAX_CONCURRENT_CONNECTIONS
        } else {
            self.max_connections
        }
    }
}

impl Default for ListenerConfig {
    fn default() -> Self {
        Self {
            interface_poll_interval: DEFAULT_INTERFACE_POLL_INTERVAL,
            code_expiry: DEFAULT_CODE_EXPIRY,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            max_connections: DEFAULT_MAX_CONNECTIONS,
            enforce_candidate_interface: true,
        }
    }
}

/// Reason a session-scoped LAN listener terminated (`LS-09`, `T-09`, `T-10`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ListenerStopReason {
    StoppedByUser,
    SessionEnded,
    Shutdown,
    NetworkChanged,
    CodeExpired,
    IdleTimeout,
}

impl ListenerStopReason {
    /// Returns the matching ADR 0008 error code when the stop was caused by an
    /// error condition (e.g. `lan_network_changed`), or `None` for normal stops.
    pub const fn error_code(self) -> Option<&'static str> {
        match self {
            Self::NetworkChanged => Some("lan_network_changed"),
            Self::StoppedByUser
            | Self::SessionEnded
            | Self::Shutdown
            | Self::CodeExpired
            | Self::IdleTimeout => None,
        }
    }

    pub fn into_network_error(self, ip: Ipv4Addr) -> Option<LanError> {
        match self {
            Self::NetworkChanged => Some(LanError::NetworkChanged(format!(
                "bound LAN address {ip} is no longer available"
            ))),
            _ => None,
        }
    }
}

/// Lightweight diagnostic events emitted by the listener for the Share UI
/// (`OD-1`, `R3-10`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ListenerEvent {
    /// An incoming TCP peer was rejected before HTTP parsing because it was
    /// outside the bound subnet or not a private IPv4 address.
    PeerBlocked {
        peer_ip: IpAddr,
        reason: PeerRejectReason,
        total_blocked: u64,
    },
    /// The listener stopped cleanly for `reason`.
    Stopped { reason: ListenerStopReason },
}

/// Handler invoked for each accepted TCP stream that passes [`PeerPolicy`].
///
/// Rejected peers are dropped before `handle` is ever called (`T-05`).
/// When `shutdown` becomes `true` (or the sender is dropped), the listener is
/// terminating and will also cancel the connection task before `wait_stopped()`
/// returns.
pub trait ConnectionHandler: Send + Sync + 'static {
    fn handle(
        &self,
        stream: TcpStream,
        peer_addr: SocketAddr,
        shutdown: watch::Receiver<bool>,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>>;
}

/// Minimal HTTP/1.1 connection handler built on `hyper` + `hyper-util` that
/// responds with `503 Service Unavailable` and `Cache-Control: no-store`.
///
/// Used as a placeholder before the `/v1` router lands in `#140` and to verify
/// `hyper` HTTP/1 plumbing in tests.
#[derive(Debug, Default, Clone, Copy)]
pub struct PlaceholderHttp1Handler;

impl ConnectionHandler for PlaceholderHttp1Handler {
    fn handle(
        &self,
        stream: TcpStream,
        _peer_addr: SocketAddr,
        mut shutdown: watch::Receiver<bool>,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        Box::pin(async move {
            use hyper::service::service_fn;
            use hyper::{Response, StatusCode, header};
            use hyper_util::rt::{TokioIo, TokioTimer};

            let io = TokioIo::new(stream);
            let service = service_fn(|_req| async {
                let mut response = Response::new(String::from("LAN sync router not configured"));
                *response.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
                response.headers_mut().insert(
                    header::CACHE_CONTROL,
                    header::HeaderValue::from_static("no-store"),
                );
                Ok::<_, std::convert::Infallible>(response)
            });

            let conn = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .keep_alive(true)
                .header_read_timeout(Duration::from_secs(10))
                .max_buf_size(8 * 1024)
                .serve_connection(io, service);
            tokio::pin!(conn);

            tokio::select! {
                biased;
                () = wait_for_shutdown(&mut shutdown) => {
                    // Drop the connection immediately so idle keep-alive sockets
                    // cannot serve another request after listener stop.
                }
                _ = &mut conn => {}
            }
        })
    }
}

async fn wait_for_shutdown(shutdown: &mut watch::Receiver<bool>) {
    if *shutdown.borrow() {
        return;
    }
    while shutdown.changed().await.is_ok() {
        if *shutdown.borrow() {
            return;
        }
    }
}

type OnStopCallback = Arc<dyn Fn(ListenerStopReason) + Send + Sync>;

enum ControlCommand {
    Stop,
    SessionEnded,
    Shutdown,
    MarkPaired,
    RecordActivity,
    ResetCodeTimer,
    SetTransferActive(bool),
    RegisterOnStop(OnStopCallback),
}

/// Cloneable control channel for notifying a running [`LanListener`] of
/// session lifecycle transitions (`MarkPaired`, `RecordActivity`,
/// `ResetCodeTimer`, transfer activity, and `SessionEnded`).
#[derive(Clone)]
pub struct ListenerControl {
    control_tx: mpsc::UnboundedSender<ControlCommand>,
    stopped_rx: watch::Receiver<Option<ListenerStopReason>>,
}

impl std::fmt::Debug for ListenerControl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ListenerControl").finish_non_exhaustive()
    }
}

impl ListenerControl {
    pub fn mark_paired(&self) {
        let _ = self.control_tx.send(ControlCommand::MarkPaired);
    }

    pub fn record_activity(&self) {
        let _ = self.control_tx.send(ControlCommand::RecordActivity);
    }

    pub fn reset_code_timer(&self) {
        let _ = self.control_tx.send(ControlCommand::ResetCodeTimer);
    }

    pub fn set_transfer_active(&self, active: bool) {
        let _ = self
            .control_tx
            .send(ControlCommand::SetTransferActive(active));
    }

    pub fn end_session(&self) {
        let _ = self.control_tx.send(ControlCommand::SessionEnded);
    }

    pub fn stop(&self) {
        let _ = self.control_tx.send(ControlCommand::Stop);
    }

    pub fn shutdown(&self) {
        let _ = self.control_tx.send(ControlCommand::Shutdown);
    }

    /// Registers a synchronous callback invoked when the listener terminates,
    /// before `wait_stopped()` resolves. If the listener has already stopped,
    /// the callback is invoked immediately.
    pub fn on_stop(&self, callback: OnStopCallback) {
        if let Some(reason) = *self.stopped_rx.borrow() {
            callback(reason);
            return;
        }
        if let Err(mpsc::error::SendError(ControlCommand::RegisterOnStop(cb))) = self
            .control_tx
            .send(ControlCommand::RegisterOnStop(callback))
        {
            let reason = self
                .stopped_rx
                .borrow()
                .unwrap_or(ListenerStopReason::Shutdown);
            cb(reason);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionPhase {
    Listening,
    Paired,
}

/// Handle to a running, session-scoped LAN listener.
///
/// Runs on the caller's Tokio runtime (never spawns a nested runtime).
pub struct LanListenerHandle {
    local_addr: SocketAddrV4,
    subnet: Ipv4Subnet,
    control_tx: mpsc::UnboundedSender<ControlCommand>,
    stopped_rx: watch::Receiver<Option<ListenerStopReason>>,
    events_tx: broadcast::Sender<ListenerEvent>,
    blocked_peers: Arc<AtomicU64>,
    panicked_connections: Arc<AtomicU64>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl LanListenerHandle {
    pub const fn local_addr(&self) -> SocketAddrV4 {
        self.local_addr
    }

    pub const fn bound_subnet(&self) -> Ipv4Subnet {
        self.subnet
    }

    /// Number of incoming peers rejected by [`PeerPolicy`] before HTTP parsing.
    pub fn blocked_peer_count(&self) -> u64 {
        self.blocked_peers.load(Ordering::Relaxed)
    }

    /// Number of connection tasks that terminated due to a panic (`T-11`).
    pub fn panicked_connection_count(&self) -> u64 {
        self.panicked_connections.load(Ordering::Acquire)
    }

    /// Subscribes to diagnostic events (e.g. blocked out-of-subnet peers and
    /// stop notifications).
    pub fn subscribe_events(&self) -> broadcast::Receiver<ListenerEvent> {
        self.events_tx.subscribe()
    }

    /// Returns a cloneable control handle for session state machines to signal
    /// pairing, activity, code regeneration, active transfers, and session end.
    pub fn control(&self) -> ListenerControl {
        ListenerControl {
            control_tx: self.control_tx.clone(),
            stopped_rx: self.stopped_rx.clone(),
        }
    }

    /// Transitions the listener from unpaired (code-expiry timer) to paired
    /// (idle timeout timer).
    pub fn mark_paired(&self) {
        let _ = self.control_tx.send(ControlCommand::MarkPaired);
    }

    /// Resets the paired session idle timer (called on authorized requests or
    /// active transfer progress).
    pub fn record_activity(&self) {
        let _ = self.control_tx.send(ControlCommand::RecordActivity);
    }

    /// Resets the unpaired code-expiry timer (called on Regenerate code).
    pub fn reset_code_timer(&self) {
        let _ = self.control_tx.send(ControlCommand::ResetCodeTimer);
    }

    /// Requests an explicit user-initiated stop (`ListenerStopReason::StoppedByUser`).
    pub fn stop(&self) {
        let _ = self.control_tx.send(ControlCommand::Stop);
    }

    /// Requests an app-shutdown stop (`ListenerStopReason::Shutdown`).
    pub fn shutdown(&self) {
        let _ = self.control_tx.send(ControlCommand::Shutdown);
    }

    /// Returns the stop reason immediately if the listener has already stopped.
    pub fn stop_reason(&self) -> Option<ListenerStopReason> {
        *self.stopped_rx.borrow()
    }

    /// Waits until the listener exits and returns the exact [`ListenerStopReason`].
    pub async fn wait_stopped(&mut self) -> ListenerStopReason {
        loop {
            if let Some(reason) = *self.stopped_rx.borrow() {
                if let Some(task) = self.task.take() {
                    let _ = task.await;
                }
                return reason;
            }
            if self.stopped_rx.changed().await.is_err() {
                return self.stop_reason().unwrap_or(ListenerStopReason::Shutdown);
            }
        }
    }
}

impl Drop for LanListenerHandle {
    fn drop(&mut self) {
        let _ = self.control_tx.send(ControlCommand::Shutdown);
    }
}

/// Session-scoped LAN TCP listener with peer subnet filtering, connection cap,
/// periodic interface polling, and code/idle timeouts (`LS-09`).
pub struct LanListener;

impl LanListener {
    /// Starts the session-scoped accept and lifecycle loop on the caller's
    /// Tokio runtime.
    pub fn start<H>(
        bound: BoundListener,
        peer_policy: PeerPolicy,
        interface_provider: Arc<dyn InterfaceProvider>,
        clock: Arc<dyn MonotonicClock>,
        config: ListenerConfig,
        handler: Arc<H>,
    ) -> LanListenerHandle
    where
        H: ConnectionHandler,
    {
        let local_addr = bound.local_addr;
        let subnet = peer_policy.subnet();
        let (control_tx, control_rx) = mpsc::unbounded_channel();
        let (stopped_tx, stopped_rx) = watch::channel(None);
        let (events_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let blocked_peers = Arc::new(AtomicU64::new(0));
        let panicked_connections = Arc::new(AtomicU64::new(0));

        let task = tokio::spawn(run_listener_loop(
            bound,
            peer_policy,
            interface_provider,
            clock,
            config,
            handler,
            control_rx,
            stopped_tx,
            events_tx.clone(),
            Arc::clone(&blocked_peers),
            Arc::clone(&panicked_connections),
        ));

        LanListenerHandle {
            local_addr,
            subnet,
            control_tx,
            stopped_rx,
            events_tx,
            blocked_peers,
            panicked_connections,
            task: Some(task),
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_listener_loop<H: ConnectionHandler>(
    bound: BoundListener,
    peer_policy: PeerPolicy,
    interface_provider: Arc<dyn InterfaceProvider>,
    clock: Arc<dyn MonotonicClock>,
    config: ListenerConfig,
    handler: Arc<H>,
    mut control_rx: mpsc::UnboundedReceiver<ControlCommand>,
    stopped_tx: watch::Sender<Option<ListenerStopReason>>,
    events_tx: broadcast::Sender<ListenerEvent>,
    blocked_peers: Arc<AtomicU64>,
    panicked_connections: Arc<AtomicU64>,
) {
    let bound_ip = *bound.local_addr.ip();
    let conn_semaphore = Arc::new(Semaphore::new(config.effective_max_connections()));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let mut active_connections: JoinSet<()> = JoinSet::new();

    let mut phase = SessionPhase::Listening;
    let mut transfer_active = false;
    let mut on_stop_callbacks: Vec<OnStopCallback> = Vec::new();
    let mut deadline = clock.now() + config.code_expiry;
    let timer = tokio::time::sleep_until(deadline);
    tokio::pin!(timer);

    let mut poll_interval = tokio::time::interval_at(
        clock.now() + config.interface_poll_interval,
        config.interface_poll_interval,
    );
    poll_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let stop_reason = loop {
        tokio::select! {
            biased;

            cmd = control_rx.recv() => {
                match cmd {
                    Some(ControlCommand::Stop) => break ListenerStopReason::StoppedByUser,
                    Some(ControlCommand::SessionEnded) => break ListenerStopReason::SessionEnded,
                    Some(ControlCommand::Shutdown) | None => break ListenerStopReason::Shutdown,
                    Some(ControlCommand::MarkPaired) => {
                        phase = SessionPhase::Paired;
                        deadline = clock.now() + config.idle_timeout;
                        timer.as_mut().reset(deadline);
                    }
                    Some(ControlCommand::RecordActivity) => {
                        if phase == SessionPhase::Paired {
                            deadline = clock.now() + config.idle_timeout;
                            timer.as_mut().reset(deadline);
                        }
                    }
                    Some(ControlCommand::ResetCodeTimer) => {
                        if phase == SessionPhase::Listening {
                            deadline = clock.now() + config.code_expiry;
                            timer.as_mut().reset(deadline);
                        }
                    }
                    Some(ControlCommand::SetTransferActive(active)) => {
                        transfer_active = active;
                        if phase == SessionPhase::Paired {
                            deadline = clock.now() + config.idle_timeout;
                            timer.as_mut().reset(deadline);
                        }
                    }
                    Some(ControlCommand::RegisterOnStop(cb)) => {
                        on_stop_callbacks.push(cb);
                    }
                }
            }

            () = &mut timer => {
                match phase {
                    SessionPhase::Listening => break ListenerStopReason::CodeExpired,
                    SessionPhase::Paired => {
                        if transfer_active {
                            // Active file transfers count as session activity (ADR 0008).
                            deadline = clock.now() + config.idle_timeout;
                            timer.as_mut().reset(deadline);
                        } else {
                            break ListenerStopReason::IdleTimeout;
                        }
                    }
                }
            }

            _ = poll_interval.tick() => {
                if !is_bound_ip_still_present(
                    interface_provider.as_ref(),
                    bound_ip,
                    config.enforce_candidate_interface,
                ) {
                    break ListenerStopReason::NetworkChanged;
                }
            }

            Some(join_res) = active_connections.join_next(), if !active_connections.is_empty() => {
                if let Err(err) = join_res
                    && err.is_panic()
                {
                    panicked_connections.fetch_add(1, Ordering::Release);
                }
            }

            accept_res = bound.listener.accept() => {
                match accept_res {
                    Ok((stream, peer_addr)) => {
                        if let Err(reason) = peer_policy.check_peer(peer_addr.ip()) {
                            // Drop stream immediately BEFORE reading any bytes or
                            // invoking any HTTP parser (T-05).
                            drop(stream);
                            let total_blocked = blocked_peers.fetch_add(1, Ordering::Relaxed) + 1;
                            let _ = events_tx.send(ListenerEvent::PeerBlocked {
                                peer_ip: peer_addr.ip(),
                                reason,
                                total_blocked,
                            });
                            continue;
                        }

                        // Enforce concurrent connection cap (ADR 0008: <= 4).
                        let Ok(permit) = Arc::clone(&conn_semaphore).try_acquire_owned() else {
                            drop(stream);
                            continue;
                        };

                        let handler = Arc::clone(&handler);
                        let mut conn_shutdown = shutdown_rx.clone();
                        let handler_shutdown = shutdown_rx.clone();
                        active_connections.spawn(async move {
                            let _permit = permit;
                            let fut = handler.handle(stream, peer_addr, handler_shutdown);
                            tokio::select! {
                                biased;
                                () = wait_for_shutdown(&mut conn_shutdown) => {}
                                () = fut => {}
                            }
                        });
                    }
                    Err(_) => {
                        // Transient OS accept errors (e.g. peer reset before accept
                        // completed) should not crash the listener; network loss is
                        // caught deterministically by the interface poll.
                    }
                }
            }
        }
    };

    // Stop accepting new sockets, cancel every active connection (including
    // idle HTTP/1.1 keep-alive connections), drain all connection tasks, and
    // run registered stop callbacks (e.g. revoking paired session credentials)
    // before publishing the stop reason so `wait_stopped()` guarantees zero
    // live sockets or active credentials remain (T-02, T-10).
    drop(bound.listener);
    let _ = shutdown_tx.send(true);
    active_connections.abort_all();
    while let Some(join_res) = active_connections.join_next().await {
        if let Err(err) = join_res
            && err.is_panic()
        {
            panicked_connections.fetch_add(1, Ordering::Release);
        }
    }

    // Drain any RegisterOnStop commands queued right before loop exit.
    control_rx.close();
    while let Some(cmd) = control_rx.recv().await {
        if let ControlCommand::RegisterOnStop(cb) = cmd {
            on_stop_callbacks.push(cb);
        }
    }
    for cb in on_stop_callbacks {
        cb(stop_reason);
    }

    let _ = stopped_tx.send(Some(stop_reason));
    let _ = events_tx.send(ListenerEvent::Stopped {
        reason: stop_reason,
    });
}

fn is_bound_ip_still_present(
    provider: &dyn InterfaceProvider,
    bound_ip: Ipv4Addr,
    enforce_candidate_interface: bool,
) -> bool {
    let Ok(raw) = provider.list_interfaces() else {
        return false;
    };

    if enforce_candidate_interface {
        select_candidate_interfaces(&raw)
            .iter()
            .any(|candidate| candidate.ip() == bound_ip)
    } else {
        raw.iter().any(|iface| iface.is_up && iface.ip == bound_ip)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    use crate::address::{AddressPolicy, RawInterface};
    use crate::bind::bind_auto_for_tests;
    use crate::error::LanResult;

    struct FakeInterfaceProvider {
        interfaces: Mutex<Vec<RawInterface>>,
    }

    impl FakeInterfaceProvider {
        fn new(interfaces: Vec<RawInterface>) -> Self {
            Self {
                interfaces: Mutex::new(interfaces),
            }
        }

        fn set(&self, interfaces: Vec<RawInterface>) {
            *self.interfaces.lock().expect("lock") = interfaces;
        }
    }

    impl InterfaceProvider for FakeInterfaceProvider {
        fn list_interfaces(&self) -> LanResult<Vec<RawInterface>> {
            Ok(self.interfaces.lock().expect("lock").clone())
        }
    }

    struct CountingHandler {
        calls: AtomicU64,
    }

    impl CountingHandler {
        fn new() -> Self {
            Self {
                calls: AtomicU64::new(0),
            }
        }

        fn count(&self) -> u64 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl ConnectionHandler for CountingHandler {
        fn handle(
            &self,
            mut stream: TcpStream,
            _peer_addr: SocketAddr,
            _shutdown: watch::Receiver<bool>,
        ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                let _ = stream.write_all(b"OK").await;
                let _ = stream.shutdown().await;
            })
        }
    }

    fn loopback_raw_iface() -> RawInterface {
        RawInterface {
            name: "lo0".into(),
            ip: Ipv4Addr::LOCALHOST,
            netmask: Ipv4Addr::new(255, 0, 0, 0),
            prefix_len: 8,
            is_up: true,
            is_loopback: true,
            is_broadcast: false,
            is_point_to_point: false,
        }
    }

    fn bind_ephemeral_loopback() -> BoundListener {
        let probe = std::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .expect("probe port");
        let port = probe.local_addr().expect("addr").port();
        drop(probe);
        bind_auto_for_tests(
            Ipv4Addr::LOCALHOST,
            port..=port.saturating_add(10),
            AddressPolicy::loopback_for_tests(),
        )
        .expect("bind loopback")
    }

    // T-05: Rejected peer is dropped BEFORE HTTP/connection handler and emits PeerBlocked event
    #[tokio::test]
    async fn t05_rejected_peer_never_reaches_handler_and_emits_event() {
        let bound = bind_ephemeral_loopback();
        let addr = bound.local_addr;

        // Configure a peer policy whose subnet is 192.168.1.0/24 (does NOT
        // contain 127.0.0.1), so a connecting 127.0.0.1 peer is rejected as
        // OutOfSubnet before the handler is ever invoked.
        let non_matching_subnet =
            Ipv4Subnet::from_prefix(Ipv4Addr::new(192, 168, 1, 10), 24).expect("subnet");
        let peer_policy = PeerPolicy::for_subnet_for_tests(non_matching_subnet, true);

        let provider = Arc::new(FakeInterfaceProvider::new(vec![loopback_raw_iface()]));
        let handler = Arc::new(CountingHandler::new());
        let mut handle = LanListener::start(
            bound,
            peer_policy,
            provider,
            Arc::new(TokioMonotonicClock),
            ListenerConfig {
                enforce_candidate_interface: false,
                ..ListenerConfig::default()
            },
            Arc::clone(&handler),
        );

        let mut events = handle.subscribe_events();

        // Connect from 127.0.0.1 and attempt to read.
        let mut client = TcpStream::connect(addr).await.expect("connect");
        let mut buf = [0u8; 16];
        let n = client.read(&mut buf).await.unwrap_or(0);
        assert_eq!(n, 0, "rejected peer must receive EOF without response");

        let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .expect("event before timeout")
            .expect("event ok");
        assert_eq!(
            event,
            ListenerEvent::PeerBlocked {
                peer_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
                reason: PeerRejectReason::OutOfSubnet,
                total_blocked: 1,
            }
        );
        assert_eq!(handle.blocked_peer_count(), 1);
        assert_eq!(
            handler.count(),
            0,
            "connection handler must never run for rejected peers"
        );

        handle.stop();
        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::StoppedByUser
        );
    }

    #[tokio::test]
    async fn allowed_peer_reaches_http1_handler() {
        let bound = bind_ephemeral_loopback();
        let addr = bound.local_addr;

        let provider = Arc::new(FakeInterfaceProvider::new(vec![loopback_raw_iface()]));
        let mut handle = LanListener::start(
            bound,
            PeerPolicy::loopback_for_tests(),
            provider,
            Arc::new(TokioMonotonicClock),
            ListenerConfig {
                enforce_candidate_interface: false,
                ..ListenerConfig::default()
            },
            Arc::new(PlaceholderHttp1Handler),
        );

        let mut client = TcpStream::connect(addr).await.expect("connect");
        let req = format!("GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
        client.write_all(req.as_bytes()).await.expect("write");
        let mut resp = String::new();
        client.read_to_string(&mut resp).await.expect("read");

        assert!(
            resp.starts_with("HTTP/1.1 503"),
            "unexpected response: {resp}"
        );
        assert!(
            resp.to_ascii_lowercase()
                .contains("cache-control: no-store")
        );
        assert_eq!(handle.blocked_peer_count(), 0);

        handle.stop();
        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::StoppedByUser
        );
    }

    // T-09: Bound address disappearance detected by 5s interface poll -> lan_network_changed
    #[tokio::test(start_paused = true)]
    async fn t09_stops_with_network_changed_when_bound_address_disappears() {
        let bound = bind_ephemeral_loopback();
        let provider = Arc::new(FakeInterfaceProvider::new(vec![loopback_raw_iface()]));

        let mut handle = LanListener::start(
            bound,
            PeerPolicy::loopback_for_tests(),
            Arc::clone(&provider) as Arc<dyn InterfaceProvider>,
            Arc::new(TokioMonotonicClock),
            ListenerConfig {
                interface_poll_interval: Duration::from_secs(5),
                enforce_candidate_interface: false,
                ..ListenerConfig::default()
            },
            Arc::new(CountingHandler::new()),
        );

        // Advance past first 5s poll while interface is still present -> stays alive.
        tokio::time::advance(Duration::from_secs(6)).await;
        tokio::task::yield_now().await;
        assert_eq!(handle.stop_reason(), None);

        // Remove the bound IP from the interface snapshot.
        provider.set(vec![]);

        // Advance past next 5s poll -> listener must stop with NetworkChanged.
        tokio::time::advance(Duration::from_secs(5)).await;
        let reason = handle.wait_stopped().await;
        assert_eq!(reason, ListenerStopReason::NetworkChanged);
        assert_eq!(reason.error_code(), Some("lan_network_changed"));
    }

    // T-10: Code expiry with no receiver stops cleanly
    #[tokio::test(start_paused = true)]
    async fn t10_stops_on_code_expiry_when_unpaired() {
        let bound = bind_ephemeral_loopback();
        let provider = Arc::new(FakeInterfaceProvider::new(vec![loopback_raw_iface()]));

        let mut handle = LanListener::start(
            bound,
            PeerPolicy::loopback_for_tests(),
            provider,
            Arc::new(TokioMonotonicClock),
            ListenerConfig {
                code_expiry: Duration::from_secs(600),
                idle_timeout: Duration::from_secs(600),
                interface_poll_interval: Duration::from_secs(5),
                enforce_candidate_interface: false,
                ..ListenerConfig::default()
            },
            Arc::new(CountingHandler::new()),
        );

        // At 9m59s, still listening.
        tokio::time::advance(Duration::from_secs(599)).await;
        tokio::task::yield_now().await;
        assert_eq!(handle.stop_reason(), None);

        // At 10m00s, code expires.
        tokio::time::advance(Duration::from_secs(2)).await;
        assert_eq!(handle.wait_stopped().await, ListenerStopReason::CodeExpired);
    }

    // T-10: Idle timeout stops cleanly after pairing, and activity resets timer
    #[tokio::test(start_paused = true)]
    async fn t10_idle_timeout_resets_on_activity_and_stops_when_idle() {
        let bound = bind_ephemeral_loopback();
        let provider = Arc::new(FakeInterfaceProvider::new(vec![loopback_raw_iface()]));

        let mut handle = LanListener::start(
            bound,
            PeerPolicy::loopback_for_tests(),
            provider,
            Arc::new(TokioMonotonicClock),
            ListenerConfig {
                code_expiry: Duration::from_secs(60),
                idle_timeout: Duration::from_secs(600),
                interface_poll_interval: Duration::from_secs(5),
                enforce_candidate_interface: false,
                ..ListenerConfig::default()
            },
            Arc::new(CountingHandler::new()),
        );

        // Pair before code expiry.
        tokio::time::advance(Duration::from_secs(30)).await;
        handle.mark_paired();
        tokio::task::yield_now().await;

        // Advance 500s (past code_expiry, before idle_timeout) -> record activity.
        tokio::time::advance(Duration::from_secs(500)).await;
        tokio::task::yield_now().await;
        assert_eq!(handle.stop_reason(), None);
        handle.record_activity();
        tokio::task::yield_now().await;

        // Advance another 500s (1000s total since pairing, 500s since activity) -> still alive.
        tokio::time::advance(Duration::from_secs(500)).await;
        tokio::task::yield_now().await;
        assert_eq!(handle.stop_reason(), None);

        // Advance 101s more (601s since last activity) -> stops with IdleTimeout.
        tokio::time::advance(Duration::from_secs(101)).await;
        assert_eq!(handle.wait_stopped().await, ListenerStopReason::IdleTimeout);
    }

    /// Reads one complete HTTP/1.1 response with a `Content-Length` header from
    /// a keep-alive TCP stream without closing it.
    async fn read_http1_response(stream: &mut TcpStream) -> String {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 512];
        loop {
            let n = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut tmp))
                .await
                .expect("read response before timeout")
                .expect("read response");
            assert!(n > 0, "unexpected EOF while reading first HTTP response");
            buf.extend_from_slice(&tmp[..n]);

            if let Some(header_end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers_str = String::from_utf8_lossy(&buf[..header_end]);
                let content_len = headers_str
                    .lines()
                    .find_map(|line| {
                        let (k, v) = line.split_once(':')?;
                        if k.eq_ignore_ascii_case("content-length") {
                            v.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                let total_needed = header_end + 4 + content_len;
                if buf.len() >= total_needed {
                    return String::from_utf8_lossy(&buf[..total_needed]).into_owned();
                }
            }
        }
    }

    async fn assert_keep_alive_connection_closed(stream: &mut TcpStream, addr: SocketAddrV4) {
        let req2 =
            format!("GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nConnection: keep-alive\r\n\r\n");
        // Either writing fails (broken pipe / reset) or reading returns EOF /
        // error — it must NEVER return a second HTTP response.
        if stream.write_all(req2.as_bytes()).await.is_ok() {
            let mut buf = [0u8; 256];
            match tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buf)).await {
                Ok(Ok(0)) | Ok(Err(_)) => {}
                Ok(Ok(n)) => {
                    let body = String::from_utf8_lossy(&buf[..n]);
                    panic!("expected closed connection after stop, got response: {body}");
                }
                Err(_) => panic!("timed out waiting for closed keep-alive connection"),
            }
        }
    }

    // T-10 regression: Stop must terminate already-accepted keep-alive HTTP
    // connections before `wait_stopped()` returns.
    #[tokio::test]
    async fn t10_stop_closes_active_keep_alive_connection_before_wait_stopped() {
        let bound = bind_ephemeral_loopback();
        let addr = bound.local_addr;

        let provider = Arc::new(FakeInterfaceProvider::new(vec![loopback_raw_iface()]));
        let mut handle = LanListener::start(
            bound,
            PeerPolicy::loopback_for_tests(),
            provider,
            Arc::new(TokioMonotonicClock),
            ListenerConfig {
                enforce_candidate_interface: false,
                ..ListenerConfig::default()
            },
            Arc::new(PlaceholderHttp1Handler),
        );

        let mut client = TcpStream::connect(addr).await.expect("connect");
        let req1 =
            format!("GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nConnection: keep-alive\r\n\r\n");
        client.write_all(req1.as_bytes()).await.expect("write req1");
        let resp1 = read_http1_response(&mut client).await;
        assert!(
            resp1.starts_with("HTTP/1.1 503"),
            "unexpected first response: {resp1}"
        );

        handle.stop();
        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::StoppedByUser
        );

        assert_keep_alive_connection_closed(&mut client, addr).await;
    }

    // T-10 regression: Code expiry and NetworkChanged also terminate active
    // keep-alive connections before `wait_stopped()` returns.
    #[tokio::test]
    async fn t10_timeout_and_network_change_close_active_keep_alive_connections() {
        // Case 1: CodeExpired
        {
            let bound = bind_ephemeral_loopback();
            let addr = bound.local_addr;
            let provider = Arc::new(FakeInterfaceProvider::new(vec![loopback_raw_iface()]));
            let mut handle = LanListener::start(
                bound,
                PeerPolicy::loopback_for_tests(),
                provider,
                Arc::new(TokioMonotonicClock),
                ListenerConfig {
                    code_expiry: Duration::from_millis(80),
                    interface_poll_interval: Duration::from_secs(60),
                    enforce_candidate_interface: false,
                    ..ListenerConfig::default()
                },
                Arc::new(PlaceholderHttp1Handler),
            );

            let mut client = TcpStream::connect(addr).await.expect("connect");
            let req1 =
                format!("GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nConnection: keep-alive\r\n\r\n");
            client.write_all(req1.as_bytes()).await.expect("write req1");
            let resp1 = read_http1_response(&mut client).await;
            assert!(resp1.starts_with("HTTP/1.1 503"));

            assert_eq!(handle.wait_stopped().await, ListenerStopReason::CodeExpired);
            assert_keep_alive_connection_closed(&mut client, addr).await;
        }

        // Case 2: NetworkChanged
        {
            let bound = bind_ephemeral_loopback();
            let addr = bound.local_addr;
            let provider = Arc::new(FakeInterfaceProvider::new(vec![loopback_raw_iface()]));
            let mut handle = LanListener::start(
                bound,
                PeerPolicy::loopback_for_tests(),
                Arc::clone(&provider) as Arc<dyn InterfaceProvider>,
                Arc::new(TokioMonotonicClock),
                ListenerConfig {
                    interface_poll_interval: Duration::from_millis(40),
                    enforce_candidate_interface: false,
                    ..ListenerConfig::default()
                },
                Arc::new(PlaceholderHttp1Handler),
            );

            let mut client = TcpStream::connect(addr).await.expect("connect");
            let req1 =
                format!("GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nConnection: keep-alive\r\n\r\n");
            client.write_all(req1.as_bytes()).await.expect("write req1");
            let resp1 = read_http1_response(&mut client).await;
            assert!(resp1.starts_with("HTTP/1.1 503"));

            provider.set(vec![]);
            assert_eq!(
                handle.wait_stopped().await,
                ListenerStopReason::NetworkChanged
            );
            assert_keep_alive_connection_closed(&mut client, addr).await;
        }
    }

    struct BlockingHandler {
        entered: Arc<AtomicU64>,
    }

    impl ConnectionHandler for BlockingHandler {
        fn handle(
            &self,
            mut stream: TcpStream,
            _peer_addr: SocketAddr,
            mut shutdown: watch::Receiver<bool>,
        ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
            let entered = Arc::clone(&self.entered);
            Box::pin(async move {
                entered.fetch_add(1, Ordering::SeqCst);
                let _ = stream.write_all(b"H").await;
                wait_for_shutdown(&mut shutdown).await;
            })
        }
    }

    #[tokio::test]
    async fn max_connections_clamped_to_adr_0008_upper_bound() {
        assert_eq!(
            ListenerConfig {
                max_connections: 0,
                ..ListenerConfig::default()
            }
            .effective_max_connections(),
            1
        );
        assert_eq!(
            ListenerConfig {
                max_connections: 2,
                ..ListenerConfig::default()
            }
            .effective_max_connections(),
            2
        );
        assert_eq!(
            ListenerConfig {
                max_connections: 4,
                ..ListenerConfig::default()
            }
            .effective_max_connections(),
            4
        );
        assert_eq!(
            ListenerConfig {
                max_connections: 16,
                ..ListenerConfig::default()
            }
            .effective_max_connections(),
            MAX_CONCURRENT_CONNECTIONS
        );

        // Even when a caller requests `max_connections: 16`, ADR 0008's cap of
        // 4 concurrent connections is enforced on live TCP sockets.
        let bound = bind_ephemeral_loopback();
        let addr = bound.local_addr;
        let entered = Arc::new(AtomicU64::new(0));
        let provider = Arc::new(FakeInterfaceProvider::new(vec![loopback_raw_iface()]));
        let mut handle = LanListener::start(
            bound,
            PeerPolicy::loopback_for_tests(),
            provider,
            Arc::new(TokioMonotonicClock),
            ListenerConfig {
                max_connections: 16,
                enforce_candidate_interface: false,
                ..ListenerConfig::default()
            },
            Arc::new(BlockingHandler {
                entered: Arc::clone(&entered),
            }),
        );

        let mut held = Vec::new();
        for _ in 0..MAX_CONCURRENT_CONNECTIONS {
            let mut client = TcpStream::connect(addr).await.expect("connect held");
            let mut b = [0u8; 1];
            let n = tokio::time::timeout(Duration::from_secs(2), client.read(&mut b))
                .await
                .expect("handshake byte before timeout")
                .expect("read byte");
            assert_eq!(n, 1);
            assert_eq!(&b, b"H");
            held.push(client);
        }
        assert_eq!(
            entered.load(Ordering::SeqCst),
            MAX_CONCURRENT_CONNECTIONS as u64
        );

        // 5th concurrent connection must be dropped immediately without
        // invoking the handler.
        let mut fifth = TcpStream::connect(addr).await.expect("connect 5th");
        let mut buf = [0u8; 8];
        let n = tokio::time::timeout(Duration::from_secs(2), fifth.read(&mut buf))
            .await
            .expect("5th connection closes before timeout")
            .unwrap_or(0);
        assert_eq!(n, 0, "5th concurrent connection must be rejected");
        assert_eq!(
            entered.load(Ordering::SeqCst),
            MAX_CONCURRENT_CONNECTIONS as u64
        );

        handle.stop();
        assert_eq!(
            handle.wait_stopped().await,
            ListenerStopReason::StoppedByUser
        );
        drop(held);
    }
}
