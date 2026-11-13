// GET http://<host>:47989/serverinfo (works unpaired). Sunshine nvhttp.cpp#L1168-L1258 (tag v2026.914.233613):
// XML root with <hostname>, <uniqueid>, <HttpsPort>, <ServerCodecModeSupport>, <state>, <PairStatus> ...
import { SUNSHINE } from '../../contracts.js';
import { httpGet } from '../shared/netprobe.js';

export interface ServerInfo {
  hostname: string;
  uniqueId: string;
  httpsPort: number | null;
  serverCodecModeSupport: number | undefined;
  appVersion: string | null;
  state: string | null;
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`, 'i').exec(xml);
  return m ? decodeXml(m[1]!.trim()) : null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

export function parseServerInfo(xml: string): ServerInfo {
  if (!/<root[\s>]/i.test(xml)) throw new Error('not a serverinfo XML document');
  const status = /<root[^>]*status_code="(\d+)"/i.exec(xml)?.[1];
  if (status && status !== '200') throw new Error(`serverinfo status_code ${status}`);
  const uniqueId = tag(xml, 'uniqueid');
  if (!uniqueId) throw new Error('serverinfo has no uniqueid');
  const scms = tag(xml, 'ServerCodecModeSupport');
  const https = tag(xml, 'HttpsPort');
  return {
    hostname: (tag(xml, 'hostname') ?? '').slice(0, 128),
    uniqueId: uniqueId.slice(0, 128),
    httpsPort: https && /^\d+$/.test(https) ? Number(https) : null,
    serverCodecModeSupport: scms && /^\d+$/.test(scms) ? Number(scms) : undefined,
    appVersion: tag(xml, 'appversion'),
    state: tag(xml, 'state'),
  };
}

export async function fetchServerInfo(host: string, port: number = SUNSHINE.httpPort, timeoutMs = 2500): Promise<ServerInfo> {
  const r = await httpGet(host, port, '/serverinfo', timeoutMs);
  if (r.status !== 200) throw new Error(`GET /serverinfo -> HTTP ${r.status}`);
  return parseServerInfo(r.body);
}
