use std::net::{IpAddr, Ipv4Addr, SocketAddrV4};

use if_addrs::IfAddr;
use serde::{Deserialize, Serialize};

use crate::bind::DEFAULT_LAN_PORT;
use crate::error::{LanError, LanResult};

/// Returns `true` when `ip` is a permitted V1 LAN IPv4 address per ADR 0008
/// (`OD-1`): RFC 1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`,
/// `192.168.0.0/16`) or IPv4 link-local (`169.254.0.0/16`).
///
/// Explicitly excludes `100.64.0.0/10` (CGNAT), loopback (`127.0.0.0/8`),
/// multicast (`224.0.0.0/4`), unspecified (`0.0.0.0/8`), broadcast, and public
/// addresses.
pub const fn is_lan_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
}

/// Returns `true` if `netmask` is a valid non-zero contiguous IPv4 subnet mask
/// (for example `255.255.255.0`), returning its CIDR prefix length (`1..=32`).
pub const fn contiguous_netmask_prefix(netmask: Ipv4Addr) -> Option<u8> {
    let bits = u32::from_be_bytes(netmask.octets());
    if bits == 0 {
        return None;
    }
    let ones = bits.leading_ones();
    let expected = if ones == 32 {
        u32::MAX
    } else {
        !0u32 << (32 - ones)
    };
    if bits == expected {
        Some(ones as u8)
    } else {
        None
    }
}

/// Converts a CIDR prefix length (`1..=32`) to an IPv4 subnet mask.
pub const fn prefix_to_netmask(prefix_len: u8) -> Option<Ipv4Addr> {
    if prefix_len == 0 || prefix_len > 32 {
        return None;
    }
    let bits = if prefix_len == 32 {
        u32::MAX
    } else {
        !0u32 << (32 - prefix_len)
    };
    Some(Ipv4Addr::from_bits(bits))
}

/// An IPv4 host address together with its validated contiguous subnet mask.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ipv4Subnet {
    pub ip: Ipv4Addr,
    pub netmask: Ipv4Addr,
    pub prefix_len: u8,
}

impl Ipv4Subnet {
    /// Builds a validated subnet from an IPv4 address and subnet mask.
    pub fn from_netmask(ip: Ipv4Addr, netmask: Ipv4Addr) -> LanResult<Self> {
        let prefix_len = contiguous_netmask_prefix(netmask).ok_or_else(|| {
            LanError::AddressInvalid(format!("invalid IPv4 netmask {netmask} for {ip}"))
        })?;
        Ok(Self {
            ip,
            netmask,
            prefix_len,
        })
    }

    /// Builds a validated subnet from an IPv4 address and CIDR prefix length (`1..=32`).
    pub fn from_prefix(ip: Ipv4Addr, prefix_len: u8) -> LanResult<Self> {
        let netmask = prefix_to_netmask(prefix_len).ok_or_else(|| {
            LanError::AddressInvalid(format!("invalid IPv4 prefix length /{prefix_len} for {ip}"))
        })?;
        Ok(Self {
            ip,
            netmask,
            prefix_len,
        })
    }

    /// Returns `true` when `peer` shares the same IPv4 network prefix as this subnet.
    pub const fn contains(&self, peer: Ipv4Addr) -> bool {
        let mask = u32::from_be_bytes(self.netmask.octets());
        if mask == 0 {
            return false;
        }
        let local_net = u32::from_be_bytes(self.ip.octets()) & mask;
        let peer_net = u32::from_be_bytes(peer.octets()) & mask;
        local_net == peer_net
    }
}

/// Platform-neutral snapshot of a single IPv4 network interface address.
///
/// Decoupled from `if-addrs` so unit tests can inject deterministic interface
/// snapshots (`T-06`, `T-09`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawInterface {
    pub name: String,
    pub ip: Ipv4Addr,
    pub netmask: Ipv4Addr,
    pub prefix_len: u8,
    pub is_up: bool,
    pub is_loopback: bool,
    pub is_broadcast: bool,
    pub is_point_to_point: bool,
}

/// A vetted LAN interface candidate eligible for binding a sharing listener.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanInterface {
    pub name: String,
    pub subnet: Ipv4Subnet,
}

impl LanInterface {
    pub const fn ip(&self) -> Ipv4Addr {
        self.subnet.ip
    }
}

/// Source of OS network interfaces, injectable for tests.
pub trait InterfaceProvider: Send + Sync {
    fn list_interfaces(&self) -> LanResult<Vec<RawInterface>>;
}

/// Production [`InterfaceProvider`] backed by `if-addrs`.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemInterfaceProvider;

impl InterfaceProvider for SystemInterfaceProvider {
    fn list_interfaces(&self) -> LanResult<Vec<RawInterface>> {
        let addrs = if_addrs::get_if_addrs().map_err(|err| {
            LanError::AddressUnavailable(format!("failed to enumerate network interfaces: {err}"))
        })?;

        let mut out = Vec::new();
        for iface in addrs {
            let IfAddr::V4(v4) = &iface.addr else {
                continue;
            };

            // On Windows, `if-addrs` may leave `netmask` as 0.0.0.0 if the prefix
            // table had no match even though `OnLinkPrefixLength` is populated.
            let netmask = if v4.netmask == Ipv4Addr::UNSPECIFIED {
                prefix_to_netmask(v4.prefixlen).unwrap_or(Ipv4Addr::UNSPECIFIED)
            } else {
                v4.netmask
            };

            out.push(RawInterface {
                name: iface.name.clone(),
                ip: v4.ip,
                netmask,
                prefix_len: v4.prefixlen,
                is_up: iface.is_oper_up(),
                is_loopback: iface.is_loopback(),
                is_broadcast: v4.broadcast.is_some(),
                is_point_to_point: iface.is_p2p(),
            });
        }

        Ok(out)
    }
}

/// Filters raw OS interfaces to valid V1 LAN bind candidates and orders them
/// deterministically (`LS-09`, `OD-1`, `T-06`).
///
/// Requirements:
/// - `is_up && !is_loopback && is_broadcast && !is_point_to_point`
/// - `is_lan_ipv4(ip)` (RFC 1918 private or `169.254.0.0/16` link-local)
/// - valid contiguous non-zero subnet mask
///
/// Ordering:
/// 1. RFC 1918 private addresses before `169.254.0.0/16` link-local addresses
/// 2. Lexicographically by interface name (`en0` before `en1`, etc.)
/// 3. By IPv4 address numeric order
/// 4. Deduplicated by IPv4 address
pub fn select_candidate_interfaces(raw: &[RawInterface]) -> Vec<LanInterface> {
    let mut candidates: Vec<LanInterface> = raw
        .iter()
        .filter(|iface| {
            iface.is_up
                && !iface.is_loopback
                && iface.is_broadcast
                && !iface.is_point_to_point
                && is_lan_ipv4(iface.ip)
        })
        .filter_map(|iface| {
            let subnet = Ipv4Subnet::from_netmask(iface.ip, iface.netmask)
                .or_else(|_| Ipv4Subnet::from_prefix(iface.ip, iface.prefix_len))
                .ok()?;
            Some(LanInterface {
                name: iface.name.clone(),
                subnet,
            })
        })
        .collect();

    candidates.sort_by(|a, b| {
        let a_link_local = a.subnet.ip.is_link_local();
        let b_link_local = b.subnet.ip.is_link_local();
        a_link_local
            .cmp(&b_link_local)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.subnet.ip.cmp(&b.subnet.ip))
            .then_with(|| b.subnet.prefix_len.cmp(&a.subnet.prefix_len))
    });

    let mut deduped: Vec<LanInterface> = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if !deduped
            .iter()
            .any(|existing| existing.subnet.ip == candidate.subnet.ip)
        {
            deduped.push(candidate);
        }
    }
    deduped
}

/// Enumerates eligible LAN bind candidates using `provider`.
pub fn list_candidate_interfaces(provider: &dyn InterfaceProvider) -> LanResult<Vec<LanInterface>> {
    let raw = provider.list_interfaces()?;
    Ok(select_candidate_interfaces(&raw))
}

/// Controls which IPv4 addresses are accepted by destination parsing and binding.
///
/// Production code can only construct [`AddressPolicy::lan_only`]. Loopback
/// (`127.0.0.1`) is gated behind `#[cfg(any(test, feature = "test-loopback"))]`
/// so it is unreachable from Tauri IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AddressPolicy {
    allow_loopback: bool,
}

impl AddressPolicy {
    /// Strict V1 LAN policy: RFC 1918 + `169.254.0.0/16` only.
    pub const fn lan_only() -> Self {
        Self {
            allow_loopback: false,
        }
    }

    /// Test-only policy permitting `127.0.0.1` for local loopback tests.
    #[cfg(any(test, feature = "test-loopback"))]
    pub const fn loopback_for_tests() -> Self {
        Self {
            allow_loopback: true,
        }
    }

    pub const fn is_allowed(&self, ip: Ipv4Addr) -> bool {
        if ip.is_unspecified() {
            return false;
        }
        if is_lan_ipv4(ip) {
            return true;
        }
        self.allow_loopback && ip.is_loopback()
    }

    pub fn validate_ip(&self, ip: Ipv4Addr) -> LanResult<Ipv4Addr> {
        if self.is_allowed(ip) {
            Ok(ip)
        } else {
            Err(LanError::AddressInvalid(format!(
                "{ip} is not a permitted local network IPv4 address"
            )))
        }
    }
}

/// Parses a user-entered IPv4 literal (`a.b.c.d` or `a.b.c.d:port`) without
/// performing any DNS resolution, validating it against `policy`.
pub fn parse_lan_address(input: &str, policy: AddressPolicy) -> LanResult<SocketAddrV4> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(LanError::AddressInvalid(
            "LAN address must not be empty".into(),
        ));
    }

    if trimmed.contains("://") || trimmed.contains('/') || trimmed.contains('[') {
        return Err(LanError::AddressInvalid(format!(
            "expected IPv4 literal (a.b.c.d or a.b.c.d:port), got '{trimmed}'"
        )));
    }

    let (ip_str, port) = match trimmed.split_once(':') {
        Some((host, port_str)) => {
            if port_str.contains(':') {
                return Err(LanError::AddressInvalid(format!(
                    "expected IPv4 literal (a.b.c.d or a.b.c.d:port), got '{trimmed}'"
                )));
            }
            let port: u16 = port_str
                .parse()
                .map_err(|_| LanError::AddressInvalid(format!("invalid port in '{trimmed}'")))?;
            if port == 0 {
                return Err(LanError::AddressInvalid(format!(
                    "port must be between 1 and 65535 in '{trimmed}'"
                )));
            }
            (host, port)
        }
        None => (trimmed, DEFAULT_LAN_PORT),
    };

    let ip: Ipv4Addr = ip_str.parse().map_err(|_| {
        LanError::AddressInvalid(format!(
            "'{ip_str}' is not a valid IPv4 literal (hostnames are not allowed)"
        ))
    })?;

    policy.validate_ip(ip)?;
    Ok(SocketAddrV4::new(ip, port))
}

/// Reason an incoming TCP peer was rejected before HTTP parsing (`T-05`, `OD-1`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PeerRejectReason {
    NonIpv4,
    NonPrivateAddress,
    OutOfSubnet,
}

/// Enforces incoming peer IP validation on the source listener before any HTTP
/// request bytes are read (`T-05`, `OD-1`, `R3-10`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerPolicy {
    subnet: Ipv4Subnet,
    allow_loopback: bool,
}

impl PeerPolicy {
    /// Production policy bound to a vetted LAN interface subnet.
    pub fn for_subnet(subnet: Ipv4Subnet) -> LanResult<Self> {
        AddressPolicy::lan_only().validate_ip(subnet.ip)?;
        if contiguous_netmask_prefix(subnet.netmask).is_none() {
            return Err(LanError::AddressInvalid(format!(
                "invalid subnet mask {} for {}",
                subnet.netmask, subnet.ip
            )));
        }
        Ok(Self {
            subnet,
            allow_loopback: false,
        })
    }

    /// Test-only policy permitting loopback peers (`127.0.0.1/32` or a custom
    /// loopback subnet) for automated tests without exposing loopback to IPC.
    #[cfg(any(test, feature = "test-loopback"))]
    pub fn loopback_for_tests() -> Self {
        Self {
            subnet: Ipv4Subnet {
                ip: Ipv4Addr::LOCALHOST,
                netmask: Ipv4Addr::new(255, 0, 0, 0),
                prefix_len: 8,
            },
            allow_loopback: true,
        }
    }

    /// Test-only policy with an explicit subnet (useful for simulating
    /// out-of-subnet peer rejections on loopback sockets in `T-05`).
    #[cfg(any(test, feature = "test-loopback"))]
    pub fn for_subnet_for_tests(subnet: Ipv4Subnet, allow_loopback: bool) -> Self {
        Self {
            subnet,
            allow_loopback,
        }
    }

    pub const fn subnet(&self) -> Ipv4Subnet {
        self.subnet
    }

    pub fn check_peer(&self, peer: IpAddr) -> Result<Ipv4Addr, PeerRejectReason> {
        let IpAddr::V4(v4) = peer else {
            return Err(PeerRejectReason::NonIpv4);
        };

        let addr_allowed = is_lan_ipv4(v4) || (self.allow_loopback && v4.is_loopback());
        if !addr_allowed {
            return Err(PeerRejectReason::NonPrivateAddress);
        }

        if !self.subnet.contains(v4) {
            return Err(PeerRejectReason::OutOfSubnet);
        }

        Ok(v4)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv6Addr;

    fn raw_iface(
        name: &str,
        ip: Ipv4Addr,
        netmask: Ipv4Addr,
        is_up: bool,
        is_loopback: bool,
        is_broadcast: bool,
        is_point_to_point: bool,
    ) -> RawInterface {
        RawInterface {
            name: name.to_string(),
            ip,
            netmask,
            prefix_len: contiguous_netmask_prefix(netmask).unwrap_or(0),
            is_up,
            is_loopback,
            is_broadcast,
            is_point_to_point,
        }
    }

    #[test]
    fn lan_ipv4_classification_matches_od1() {
        // RFC 1918 allowed
        assert!(is_lan_ipv4(Ipv4Addr::new(10, 0, 0, 1)));
        assert!(is_lan_ipv4(Ipv4Addr::new(172, 16, 0, 1)));
        assert!(is_lan_ipv4(Ipv4Addr::new(172, 31, 255, 254)));
        assert!(is_lan_ipv4(Ipv4Addr::new(192, 168, 1, 42)));

        // Link-local 169.254/16 allowed (OD-1)
        assert!(is_lan_ipv4(Ipv4Addr::new(169, 254, 10, 20)));

        // Excluded ranges
        assert!(!is_lan_ipv4(Ipv4Addr::new(100, 64, 0, 1))); // CGNAT / Tailscale
        assert!(!is_lan_ipv4(Ipv4Addr::new(100, 127, 255, 254))); // CGNAT upper bound
        assert!(!is_lan_ipv4(Ipv4Addr::LOCALHOST)); // Loopback
        assert!(!is_lan_ipv4(Ipv4Addr::UNSPECIFIED)); // 0.0.0.0
        assert!(!is_lan_ipv4(Ipv4Addr::new(8, 8, 8, 8))); // Public
        assert!(!is_lan_ipv4(Ipv4Addr::new(172, 15, 0, 1))); // Just below 172.16/12
        assert!(!is_lan_ipv4(Ipv4Addr::new(172, 32, 0, 1))); // Just above 172.31/12
        assert!(!is_lan_ipv4(Ipv4Addr::new(224, 0, 0, 251))); // Multicast (mDNS)
        assert!(!is_lan_ipv4(Ipv4Addr::BROADCAST));
    }

    // T-06: Candidate interface filter and deterministic ordering
    #[test]
    fn t06_candidate_interface_filter_and_deterministic_ordering() {
        let mask24 = Ipv4Addr::new(255, 255, 255, 0);
        let mask16 = Ipv4Addr::new(255, 255, 0, 0);

        let raw = vec![
            // Loopback -> excluded
            raw_iface(
                "lo0",
                Ipv4Addr::LOCALHOST,
                Ipv4Addr::new(255, 0, 0, 0),
                true,
                true,
                false,
                false,
            ),
            // Down Wi-Fi -> excluded
            raw_iface(
                "en2",
                Ipv4Addr::new(192, 168, 1, 50),
                mask24,
                false,
                false,
                true,
                false,
            ),
            // VPN utun (point-to-point, non-broadcast) with RFC 1918 -> excluded
            raw_iface(
                "utun3",
                Ipv4Addr::new(10, 8, 0, 2),
                mask24,
                true,
                false,
                false,
                true,
            ),
            // VPN with broadcast bit accidentally set, still point-to-point -> excluded
            raw_iface(
                "utun4",
                Ipv4Addr::new(10, 9, 0, 2),
                mask24,
                true,
                false,
                true,
                true,
            ),
            // CGNAT (Tailscale) -> excluded
            raw_iface(
                "utun5",
                Ipv4Addr::new(100, 64, 1, 2),
                mask24,
                true,
                false,
                true,
                false,
            ),
            // Public IPv4 -> excluded
            raw_iface(
                "en3",
                Ipv4Addr::new(203, 0, 113, 10),
                mask24,
                true,
                false,
                true,
                false,
            ),
            // Multicast -> excluded
            raw_iface(
                "en4",
                Ipv4Addr::new(224, 0, 0, 1),
                mask24,
                true,
                false,
                true,
                false,
            ),
            // Invalid zero netmask -> excluded
            raw_iface(
                "en5",
                Ipv4Addr::new(192, 168, 2, 10),
                Ipv4Addr::UNSPECIFIED,
                true,
                false,
                true,
                false,
            ),
            // Valid link-local -> included, sorted AFTER RFC 1918
            raw_iface(
                "en0",
                Ipv4Addr::new(169, 254, 42, 7),
                mask16,
                true,
                false,
                true,
                false,
            ),
            // Valid RFC 1918 on en1
            raw_iface(
                "en1",
                Ipv4Addr::new(10, 0, 0, 12),
                mask24,
                true,
                false,
                true,
                false,
            ),
            // Valid RFC 1918 on en0 (duplicate IP later to test dedup)
            raw_iface(
                "en0",
                Ipv4Addr::new(192, 168, 1, 20),
                mask24,
                true,
                false,
                true,
                false,
            ),
            raw_iface(
                "en0",
                Ipv4Addr::new(192, 168, 1, 20),
                mask24,
                true,
                false,
                true,
                false,
            ),
        ];

        let selected = select_candidate_interfaces(&raw);
        let summary: Vec<(&str, Ipv4Addr, u8)> = selected
            .iter()
            .map(|c| (c.name.as_str(), c.subnet.ip, c.subnet.prefix_len))
            .collect();

        assert_eq!(
            summary,
            vec![
                ("en0", Ipv4Addr::new(192, 168, 1, 20), 24),
                ("en1", Ipv4Addr::new(10, 0, 0, 12), 24),
                ("en0", Ipv4Addr::new(169, 254, 42, 7), 16),
            ]
        );
    }

    // T-05: Peer subnet filter unit checks
    #[test]
    fn t05_peer_policy_enforces_private_and_same_subnet() {
        let subnet =
            Ipv4Subnet::from_prefix(Ipv4Addr::new(192, 168, 1, 10), 24).expect("valid subnet");
        let policy = PeerPolicy::for_subnet(subnet).expect("valid policy");

        // Same subnet private peer -> allowed
        assert_eq!(
            policy.check_peer(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 99))),
            Ok(Ipv4Addr::new(192, 168, 1, 99))
        );

        // Different private subnet -> OutOfSubnet
        assert_eq!(
            policy.check_peer(IpAddr::V4(Ipv4Addr::new(192, 168, 2, 99))),
            Err(PeerRejectReason::OutOfSubnet)
        );
        assert_eq!(
            policy.check_peer(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5))),
            Err(PeerRejectReason::OutOfSubnet)
        );

        // Non-private addresses -> NonPrivateAddress
        assert_eq!(
            policy.check_peer(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))),
            Err(PeerRejectReason::NonPrivateAddress)
        );
        assert_eq!(
            policy.check_peer(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 5))),
            Err(PeerRejectReason::NonPrivateAddress)
        );
        assert_eq!(
            policy.check_peer(IpAddr::V4(Ipv4Addr::LOCALHOST)),
            Err(PeerRejectReason::NonPrivateAddress)
        );

        // IPv6 -> NonIpv4
        assert_eq!(
            policy.check_peer(IpAddr::V6(Ipv6Addr::LOCALHOST)),
            Err(PeerRejectReason::NonIpv4)
        );
    }

    #[test]
    fn production_peer_policy_rejects_loopback_subnet() {
        let loopback_subnet =
            Ipv4Subnet::from_prefix(Ipv4Addr::LOCALHOST, 8).expect("valid subnet");
        let err = PeerPolicy::for_subnet(loopback_subnet).expect_err("loopback must be rejected");
        assert_eq!(err.code(), "lan_address_invalid");
    }

    #[test]
    fn parse_lan_address_enforces_ipv4_literals_and_policy() {
        let lan = AddressPolicy::lan_only();

        assert_eq!(
            parse_lan_address("192.168.1.42", lan).expect("valid"),
            SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 42), DEFAULT_LAN_PORT)
        );
        assert_eq!(
            parse_lan_address("10.0.0.5:49320", lan).expect("valid"),
            SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 5), 49320)
        );
        assert_eq!(
            parse_lan_address("169.254.1.2:49319", lan).expect("valid"),
            SocketAddrV4::new(Ipv4Addr::new(169, 254, 1, 2), 49319)
        );

        // Reject hostnames, URLs, IPv6, public, CGNAT, loopback, port 0
        for bad in [
            "",
            "localhost:49319",
            "macbook.local:49319",
            "http://192.168.1.42:49319",
            "[::1]:49319",
            "8.8.8.8:49319",
            "100.64.0.1:49319",
            "127.0.0.1:49319",
            "0.0.0.0:49319",
            "192.168.1.42:0",
        ] {
            let err = parse_lan_address(bad, lan).expect_err(&format!("{bad} must be rejected"));
            assert_eq!(err.code(), "lan_address_invalid");
        }

        // Loopback allowed ONLY with test policy
        assert_eq!(
            parse_lan_address("127.0.0.1:49319", AddressPolicy::loopback_for_tests())
                .expect("loopback allowed in test policy"),
            SocketAddrV4::new(Ipv4Addr::LOCALHOST, 49319)
        );
    }
}
