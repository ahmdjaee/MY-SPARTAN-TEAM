import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { CONFIG } from "./config.ts";

/**
 * Pagar Host/Origin untuk API dan WebSocket.
 *
 * - Host asing = DNS rebinding (situs jahat yang namanya diarahkan ke 127.0.0.1).
 * - Origin asing = CSRF: `interrupt`, `cancel`, `curate` tidak punya body, jadi form biasa dari situs lain pun cukup.
 * - WebSocket tidak dilindungi CORS sama sekali (CSWSH), jadi Origin wajib dicek di handshake.
 *
 * Permintaan tanpa Origin (curl, skrip, gate) tetap lolos: browser selalu mengirim Origin untuk
 * POST/PUT/DELETE dan WebSocket, jadi ketiadaannya berarti bukan dari halaman web.
 */

/** Port Vite saat `bun run dev`; proxy-nya meneruskan Origin browser apa adanya. */
const VITE_PORT = 4321;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

const list = (raw: string): string[] =>
  raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

/** Alias domain lokal dari README (nginx di port 80). */
export const LOCAL_ALIAS = "ai-team.local";

/** `name` diarahkan ke 127.x/::1 oleh isi berkas hosts ini? */
export function hostsMapsToLoopback(hostsText: string, name: string): boolean {
  for (const raw of hostsText.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [address = "", ...names] = line.split(/\s+/);
    if (!address.startsWith("127.") && address !== "::1") continue;
    if (names.some((entry) => entry.toLowerCase() === name)) return true;
  }
  return false;
}

function readHosts(): string {
  try {
    return readFileSync("/etc/hosts", "utf8");
  } catch {
    return "";
  }
}

const hosts = new Set([...LOOPBACK, ...list(CONFIG.allowedHosts)]);

/** Dibaca ulang paling sering tiap 30 detik: menambah baris /etc/hosts tidak perlu me-restart server. */
const ALIAS_RECHECK_MS = 30_000;
let aliasCheckedAt = Number.NEGATIVE_INFINITY;
let aliasMapped = false;

/**
 * Alias `.local` hanya dipercaya kalau /etc/hosts mengarahkannya ke mesin ini. Tanpa baris itu nama
 * tersebut dijawab mDNS — perangkat lain di LAN bisa mengklaimnya lalu memakainya untuk DNS rebinding.
 */
function knownHost(name: string): boolean {
  if (hosts.has(name)) return true;
  if (name !== LOCAL_ALIAS) return false;
  const now = Date.now();
  if (now - aliasCheckedAt >= ALIAS_RECHECK_MS) {
    aliasCheckedAt = now;
    aliasMapped = hostsMapsToLoopback(readHosts(), LOCAL_ALIAS);
  }
  return aliasMapped;
}
// HOST=192.168.x.x (bind ke LAN) ikut diizinkan; 0.0.0.0/:: bukan nama yang dipakai browser.
if (CONFIG.host && CONFIG.host !== "0.0.0.0" && CONFIG.host !== "::") hosts.add(CONFIG.host.toLowerCase());
const origins = new Set(list(CONFIG.allowedOrigins).map((origin) => origin.replace(/\/+$/, "")));

/** "localhost:4320" → "localhost"; "[::1]:4320" → "::1". */
function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]"));
  const colon = value.indexOf(":");
  return colon >= 0 ? value.slice(0, colon) : value;
}

export function allowedHost(host: string | undefined): boolean {
  // Tanpa Host (HTTP/1.0, alat lokal) bukan dari browser — DNS rebinding selalu membawa Host.
  if (!host) return true;
  return knownHost(hostnameOf(host));
}

export function allowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  const normalized = origin.trim().toLowerCase().replace(/\/+$/, "");
  if (origins.has(normalized)) return true;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    // "null" (iframe sandbox, file://) dan sampah lain
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const name = url.hostname.replace(/^\[|\]$/g, "");
  if (!knownHost(name)) return false;
  if (url.port === String(CONFIG.port) || url.port === String(VITE_PORT)) return true;
  // Port bawaan (80/443) hanya untuk nama yang dilayani nginx; di localhost:80 bisa tinggal situs lokal lain.
  return url.port === "" && !LOOPBACK.has(name);
}

/** Alasan penolakan, atau undefined kalau lolos. Dipakai middleware Express dan handshake WebSocket. */
export function rejectReason(headers: IncomingHttpHeaders, method = "GET"): string | undefined {
  if (!allowedHost(headers.host)) return "Host tidak dikenal — tambahkan ke ALLOWED_HOSTS di .env";
  const origin = typeof headers.origin === "string" ? headers.origin : undefined;
  if (!allowedOrigin(origin)) return "Origin tidak diizinkan — tambahkan ke ALLOWED_ORIGINS di .env";
  const site = headers["sec-fetch-site"];
  if (method !== "GET" && method !== "HEAD" && site === "cross-site") return "permintaan lintas situs ditolak";
  return undefined;
}

export function httpGuard(req: Request, res: Response, next: NextFunction): void {
  const reason = rejectReason(req.headers, req.method);
  if (reason) {
    res.status(403).json({ error: reason });
    return;
  }
  next();
}
