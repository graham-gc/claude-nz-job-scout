// Address classification without an external dependency.
//
// Only globally routable unicast addresses are public. Loopback, private,
// link-local, carrier-grade NAT, documentation, benchmarking, multicast and
// reserved ranges are all refused before a request is made.

function ipv4Parts(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map(p => (p === '' ? NaN : Number(p)));
  if (numbers.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  if (parts.some(p => p.length > 1 && p.startsWith('0'))) return null;
  return numbers;
}
function toLong(numbers) { return (((numbers[0] * 256 + numbers[1]) * 256 + numbers[2]) * 256 + numbers[3]) >>> 0; }

const IPV4_RANGES = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrierGradeNat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'linkLocal'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

export function isIPv4(address) { return ipv4Parts(address) !== null; }

export function ipv4Range(address) {
  const numbers = ipv4Parts(address);
  if (!numbers) return null;
  const value = toLong(numbers);
  for (const [base, bits, name] of IPV4_RANGES) {
    const baseLong = toLong(ipv4Parts(base));
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (baseLong & mask) >>> 0) return name;
  }
  if (value === 0xffffffff) return 'broadcast';
  return 'unicast';
}

// --- IPv6 --------------------------------------------------------------------
function expandIPv6(address) {
  let text = String(address).trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const embedded = text.split('::');
  if (embedded.length > 2) return null;
  let head = embedded[0] ? embedded[0].split(':') : [];
  let tail = embedded.length === 2 ? (embedded[1] ? embedded[1].split(':') : []) : [];
  const groups = [];
  const push = list => { for (const part of list) { if (!/^[0-9a-f]{1,4}$/.test(part)) return false; groups.push(parseInt(part, 16)); } return true; };
  if (!push(head)) return null;
  const saved = groups.length;
  if (!push(tail)) return null;
  if (embedded.length === 2) {
    const fill = 8 - saved - tail.length;
    if (fill < 0) return null;
    for (let i = 0; i < fill; i++) groups.splice(saved + i, 0, 0);
  }
  if (groups.length !== 8) return null;
  return groups;
}
export function isIPv6(address) { return expandIPv6(address) !== null; }

function ipv6Range(groups) {
  const all = groups.every(g => g === 0);
  if (all) return 'unspecified';
  if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1) return 'loopback';
  if (groups[0] === 0xff) return 'multicast';
  if ((groups[0] & 0xfe00) === 0xfc00) return 'uniqueLocal';
  if ((groups[0] & 0xffc0) === 0xfe80) return 'linkLocal';
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return 'documentation';
  if (groups[0] === 0x2002) return '6to4';
  if (groups[0] === 0x2001 && groups[1] === 0x0000) return 'teredo';
  if (groups[0] === 0x0100 && groups[1] === 0x0000) return 'rfc6666';
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) return 'rfc6145';
  // IPv4-mapped and IPv4-compatible forms are judged by the embedded address.
  if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) {
    const embedded4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    return ipv4Range(embedded4) === 'unicast' ? 'ipv4Mapped' : ipv4Range(embedded4);
  }
  if (groups.slice(0, 6).every(g => g === 0)) {
    const embedded4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    const range = ipv4Range(embedded4);
    if (range !== 'unicast') return range;
  }
  return 'unicast';
}

export function rangeOf(address) {
  const text = String(address ?? '').trim();
  if (isIPv4(text)) return ipv4Range(text);
  const groups = expandIPv6(text);
  if (!groups) return null;
  return ipv6Range(groups);
}
export function isPublicAddress(address) {
  const range = rangeOf(address);
  if (!range) return false;
  if (range === 'unicast' || range === 'ipv4Mapped') return true;
  return false;
}
export const isValidAddress = address => rangeOf(address) !== null;
