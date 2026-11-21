use std::io::{self, ErrorKind};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::ops::RangeInclusive;

use socket2::{Domain, Protocol, SockAddr, Socket, Type};
use tokio::net::TcpListener;

use crate::address::AddressPolicy;
use crate::error::{LanError, LanResult};

/// First port in the V1 LAN sync auto-bind range (ADR 0008).
pub const LAN_PORT_START: u16 = 49319;
/// Last port in the V1 LAN sync auto-bind range (ADR 0008).
pub const LAN_PORT_END: u16 = 49328;
/// Default LAN sync port when the user enters a bare IPv4 literal.
pub const DEFAULT_LAN_PORT: u16 = LAN_PORT_START;

const LISTEN_BACKLOG: i32 = 128;

/// A bound IPv4 TCP listener ready to be driven by [`crate::LanListener`].
#[derive(Debug)]
pub struct BoundListener {
    pub listener: TcpListener,
    pub local_addr: SocketAddrV4,
}

/// Binds a TCP listener strictly on `ip` (never `0.0.0.0`), trying ports
/// `49319..=49328` and advancing **only** on `EADDRINUSE` (`LS-09`, `T-07`).
///
/// Must be called inside an active Tokio runtime (reuses the caller's runtime).
pub fn bind_auto(ip: Ipv4Addr) -> LanResult<BoundListener> {
    bind_auto_in_range(ip, LAN_PORT_START..=LAN_PORT_END, AddressPolicy::lan_only())
}

/// Test-only variant of [`bind_auto`] allowing a custom [`AddressPolicy`] and
/// port range (e.g. `127.0.0.1` on ephemeral test ports).
#[cfg(any(test, feature = "test-loopback"))]
pub fn bind_auto_for_tests(
    ip: Ipv4Addr,
    ports: RangeInclusive<u16>,
    policy: AddressPolicy,
) -> LanResult<BoundListener> {
    bind_auto_in_range(ip, ports, policy)
}

fn bind_auto_in_range(
    ip: Ipv4Addr,
    ports: RangeInclusive<u16>,
    policy: AddressPolicy,
) -> LanResult<BoundListener> {
    if ip.is_unspecified() {
        return Err(LanError::AddressInvalid(
            "binding 0.0.0.0 is forbidden; select a specific LAN IPv4 address".into(),
        ));
    }
    policy.validate_ip(ip)?;

    let std_listener = bind_range_with(ip, ports, bind_single_socket)?;
    let local_addr = match std_listener.local_addr() {
        Ok(SocketAddr::V4(v4)) => v4,
        Ok(SocketAddr::V6(_)) => {
            return Err(LanError::BindFailed(
                "expected IPv4 bound socket address".into(),
            ));
        }
        Err(err) => {
            return Err(LanError::BindFailed(format!(
                "failed to query bound socket address on {ip}: {err}"
            )));
        }
    };

    let listener = TcpListener::from_std(std_listener).map_err(|err| {
        LanError::BindFailed(format!(
            "failed to register bound listener {local_addr} with Tokio runtime: {err}"
        ))
    })?;

    Ok(BoundListener {
        listener,
        local_addr,
    })
}

fn bind_single_socket(addr: SocketAddrV4) -> io::Result<std::net::TcpListener> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;

    // Explicit SO_REUSEADDR policy:
    // - On Unix (macOS/Linux), SO_REUSEADDR allows immediate rebind after a
    //   previous session's TIME_WAIT without permitting two active LISTEN
    //   sockets on the same (ip, port).
    // - On Windows, SO_REUSEADDR allows hijacking an active listener, so we
    //   explicitly keep it disabled.
    #[cfg(unix)]
    socket.set_reuse_address(true)?;
    #[cfg(windows)]
    socket.set_reuse_address(false)?;

    let sock_addr = SockAddr::from(SocketAddr::V4(addr));
    socket.bind(&sock_addr)?;
    socket.listen(LISTEN_BACKLOG)?;
    socket.set_nonblocking(true)?;

    Ok(socket.into())
}

fn bind_range_with<T, F>(ip: Ipv4Addr, ports: RangeInclusive<u16>, mut binder: F) -> LanResult<T>
where
    F: FnMut(SocketAddrV4) -> io::Result<T>,
{
    let start_port = *ports.start();
    let end_port = *ports.end();

    for port in ports {
        let addr = SocketAddrV4::new(ip, port);
        match binder(addr) {
            Ok(bound) => return Ok(bound),
            Err(err) => match err.kind() {
                // Advance to the next port ONLY on EADDRINUSE.
                ErrorKind::AddrInUse => continue,
                ErrorKind::AddrNotAvailable => {
                    return Err(LanError::AddressUnavailable(format!(
                        "{addr} is not assigned to a local interface: {err}"
                    )));
                }
                _ => {
                    return Err(LanError::BindFailed(format!(
                        "failed to bind {addr}: {err}"
                    )));
                }
            },
        }
    }

    Err(LanError::PortsExhausted {
        ip,
        start_port,
        end_port,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    // T-07: Port fallback advances ONLY on EADDRINUSE
    #[test]
    fn t07_advances_on_eaddrinuse_and_succeeds() {
        let ip = Ipv4Addr::new(192, 168, 1, 10);
        let tried = RefCell::new(Vec::new());

        let bound = bind_range_with(ip, 49319..=49328, |addr| {
            tried.borrow_mut().push(addr.port());
            if addr.port() < 49321 {
                Err(io::Error::new(ErrorKind::AddrInUse, "in use"))
            } else {
                Ok(addr.port())
            }
        })
        .expect("should succeed on third port");

        assert_eq!(bound, 49321);
        assert_eq!(*tried.borrow(), vec![49319, 49320, 49321]);
    }

    #[test]
    fn t07_stops_immediately_on_eaddrnotavail() {
        let ip = Ipv4Addr::new(192, 168, 1, 10);
        let tried = RefCell::new(Vec::new());

        let err = bind_range_with::<(), _>(ip, 49319..=49328, |addr| {
            tried.borrow_mut().push(addr.port());
            Err(io::Error::new(ErrorKind::AddrNotAvailable, "no such addr"))
        })
        .expect_err("must fail immediately on EADDRNOTAVAIL");

        assert_eq!(err.code(), "lan_address_unavailable");
        assert_eq!(*tried.borrow(), vec![49319]);
    }

    #[test]
    fn t07_stops_immediately_on_eacces() {
        let ip = Ipv4Addr::new(192, 168, 1, 10);
        let tried = RefCell::new(Vec::new());

        let err = bind_range_with::<(), _>(ip, 49319..=49328, |addr| {
            tried.borrow_mut().push(addr.port());
            Err(io::Error::new(ErrorKind::PermissionDenied, "eacces"))
        })
        .expect_err("must fail immediately on EACCES");

        assert_eq!(err.code(), "lan_bind_failed");
        assert_eq!(*tried.borrow(), vec![49319]);
    }

    #[test]
    fn t07_maps_range_exhaustion_to_lan_ports_exhausted() {
        let ip = Ipv4Addr::new(192, 168, 1, 10);
        let tried = RefCell::new(Vec::new());

        let err = bind_range_with::<(), _>(ip, 49319..=49328, |addr| {
            tried.borrow_mut().push(addr.port());
            Err(io::Error::new(ErrorKind::AddrInUse, "in use"))
        })
        .expect_err("must fail with PortsExhausted");

        assert_eq!(err.code(), "lan_ports_exhausted");
        assert_eq!(tried.borrow().len(), 10);
    }

    #[tokio::test]
    async fn bind_auto_rejects_wildcard_and_loopback_in_production_policy() {
        let err = bind_auto(Ipv4Addr::UNSPECIFIED).expect_err("0.0.0.0 must be rejected");
        assert_eq!(err.code(), "lan_address_invalid");

        let err = bind_auto(Ipv4Addr::LOCALHOST).expect_err("127.0.0.1 must be rejected");
        assert_eq!(err.code(), "lan_address_invalid");
    }

    #[tokio::test]
    async fn t07_real_loopback_socket_fallback_on_occupied_port() {
        // Bind an ephemeral port first to get a known-free pair of adjacent ports.
        let probe = std::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .expect("bind ephemeral port");
        let base_port = probe.local_addr().expect("local addr").port();

        // Keep `probe` holding `base_port` so `bind_auto_for_tests` must advance.
        let end_port = base_port.saturating_add(5);
        let bound = bind_auto_for_tests(
            Ipv4Addr::LOCALHOST,
            base_port..=end_port,
            AddressPolicy::loopback_for_tests(),
        )
        .expect("should fall back to next free port");

        assert_ne!(bound.local_addr.port(), base_port);
        assert!(bound.local_addr.port() > base_port && bound.local_addr.port() <= end_port);
        drop(probe);
    }

    // UA-4 / T-08: Local single-Mac bind verification comparing specific-IP
    // `bind_auto(<lan_ip>)` against another socket holding `0.0.0.0:49319` vs
    // `<lan_ip>:49319`. Ignored by default in CI because it requires a live LAN
    // interface and port 49319 availability; run manually via:
    //   cargo test -p synapse-lan ua4_t08 -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "manual local LAN verification (UA-4 / T-08)"]
    async fn ua4_t08_local_lan_bind_verification() {
        use crate::address::{SystemInterfaceProvider, list_candidate_interfaces};

        let candidates =
            list_candidate_interfaces(&SystemInterfaceProvider).expect("enumerate interfaces");
        assert!(
            !candidates.is_empty(),
            "at least one active private IPv4 LAN interface is required for UA-4"
        );
        let lan_ip = candidates[0].ip();
        println!(
            "UA-4 candidate: {} ({}/{})",
            candidates[0].name, lan_ip, candidates[0].subnet.prefix_len
        );

        // Case A: Another socket holds 0.0.0.0:49319 (no SO_REUSEADDR).
        let wildcard_holder =
            std::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, LAN_PORT_START))
                .expect("bind 0.0.0.0:49319");
        let bound_vs_wildcard = bind_auto(lan_ip).expect("bind_auto vs 0.0.0.0:49319");
        println!(
            "UA-4 Case A (holder=0.0.0.0:{}): bind_auto({}) -> {}",
            LAN_PORT_START, lan_ip, bound_vs_wildcard.local_addr
        );
        drop(bound_vs_wildcard);
        drop(wildcard_holder);

        // Case B: Another socket holds <lan_ip>:49319.
        let specific_holder =
            std::net::TcpListener::bind(SocketAddrV4::new(lan_ip, LAN_PORT_START))
                .expect("bind <lan_ip>:49319");
        let bound_vs_specific = bind_auto(lan_ip).expect("bind_auto vs <lan_ip>:49319");
        println!(
            "UA-4 Case B (holder={}:{}): bind_auto({}) -> {}",
            lan_ip, LAN_PORT_START, lan_ip, bound_vs_specific.local_addr
        );
        assert_eq!(
            bound_vs_specific.local_addr.port(),
            LAN_PORT_START + 1,
            "specific-IP holder on 49319 must cause EADDRINUSE fallback to 49320"
        );
        drop(bound_vs_specific);
        drop(specific_holder);
    }
}
