import qrcode from "qrcode-generator";
import { useEffect, useState } from "react";
import { API as SERVER_API } from "./server";

interface LanInfo {
  enabled: boolean;
  port: number;
  addresses?: string[];
  token?: string;
}

const API = `${SERVER_API}/lan`;
/** Only this computer can unpair devices (the server checks it too). */
const onThisComputer = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

/** The QR code as one SVG path: sharp at any size, dark on white so cameras read it in dark mode too. */
function Qr({ text }: { text: string }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  return (
    <svg className="qr" viewBox={`0 0 ${n + 4} ${n + 4}`} role="img" aria-label="QR code to open this board on another device">
      <rect width={n + 4} height={n + 4} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/**
 * Pair another device (an iPad) with this server: a QR code with the network
 * address and the access token. `path` is what the device opens (this board, or the home page).
 */
export function LanPair({ path }: { path: string }) {
  const [info, setInfo] = useState<LanInfo | null>(null);
  const [ip, setIp] = useState<string | null>(null);

  const load = (reset = false) =>
    fetch(reset ? `${API}/reset` : API, { method: reset ? "POST" : "GET" })
      .then((r) => r.json() as Promise<LanInfo>)
      .then(setInfo)
      .catch(() => setInfo(null));

  useEffect(() => {
    void load();
  }, []);

  if (!info) return null;
  if (!info.enabled) {
    return (
      <p className="muted small">
        To open boards from a tablet on the same Wi-Fi, run Livingboard with <code>--lan</code>: <code>livingboard install --lan</code> (then restart
        Claude Code) or <code>livingboard start --lan</code>.
      </p>
    );
  }

  const addresses = info.addresses ?? [];
  const host = ip && addresses.includes(ip) ? ip : addresses[0];
  if (!host) return <p className="muted small">No network found on this computer.</p>;
  const url = `http://${host}:${info.port}${path}${path.includes("?") ? "&" : "?"}t=${info.token}`;

  return (
    <div className="lan">
      <Qr text={url} />
      <p className="small">Scan it with the tablet's camera, on the same Wi-Fi. The tablet stays paired.</p>
      {addresses.length > 1 && (
        <label className="lan-ip small">
          <span className="muted">Network</span>
          <select value={host} onChange={(e) => setIp(e.target.value)}>
            {addresses.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      )}
      {onThisComputer && (
        <button
          type="button"
          className="link-btn small"
          onClick={() => {
            if (window.confirm("Unpair every device? They will need to scan the new QR code.")) void load(true);
          }}
        >
          Unpair all devices
        </button>
      )}
    </div>
  );
}
