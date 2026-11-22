import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

export interface LocalTlsRequestOptions {
  method?: 'GET' | 'POST' | 'HEAD' | 'OPTIONS' | 'PUT' | 'PROPFIND' | 'MKCOL' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  allowLocalSelfSignedTls?: boolean;
  customCaPem?: string | null;
  maxRedirects?: number;
}

export interface LocalTlsResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  tlsBypassedForLocalSelfSigned: boolean;
  tlsCertificateError?: string;
}

export function isLocalLanHostnameOrIp(hostOrIp: string): boolean {
  const clean = hostOrIp
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/^::ffff:/i, '')
    .toLowerCase();
  if (!clean) return false;

  if (
    clean === 'localhost' ||
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean === 'fritz.box' ||
    clean === 'fritz.nas' ||
    clean.endsWith('.fritz.box') ||
    clean.endsWith('.fritz.nas') ||
    clean.endsWith('.box') ||
    clean.endsWith('.local') ||
    clean.endsWith('.lan') ||
    clean.endsWith('.home') ||
    clean.endsWith('.internal')
  ) {
    return true;
  }

  if (clean.startsWith('10.') || clean.startsWith('192.168.') || clean.startsWith('169.254.')) {
    return true;
  }
  if (clean.startsWith('172.')) {
    const second = Number(clean.split('.')[1]);
    if (Number.isFinite(second) && second >= 16 && second <= 31) {
      return true;
    }
  }
  return clean.startsWith('fc') || clean.startsWith('fd') || clean.startsWith('fe80:');
}

function buildPemTrustList(customCaPem?: string | null): string[] | undefined {
  if (!customCaPem || !customCaPem.includes('-----BEGIN CERTIFICATE-----')) {
    return undefined;
  }
  return [...tls.rootCertificates, customCaPem.trim()];
}

export async function requestWithLocalTlsPolicy(
  rawUrl: string,
  options: LocalTlsRequestOptions = {}
): Promise<LocalTlsResponse> {
  const method = options.method ?? 'GET';
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 4500, 400), 20000);
  const allowLocalSelfSignedTls = options.allowLocalSelfSignedTls ?? true;
  const maxRedirects = options.maxRedirects ?? 3;

  const parsed = new URL(rawUrl);
  const isHttps = parsed.protocol === 'https:';
  const isLocalHost = isLocalLanHostnameOrIp(parsed.hostname);
  const caList = buildPemTrustList(options.customCaPem);

  const attemptRequest = (allowInsecureLocal: boolean): Promise<LocalTlsResponse> =>
    new Promise((resolve, reject) => {
      const reqHeaders: Record<string, string> = {
        Accept: 'application/xml, application/json, text/xml, text/plain, */*',
        'User-Agent': 'EntenCenter-NAS/1.0',
        ...(options.headers ?? {}),
      };
      const bodyBuf = Buffer.isBuffer(options.body)
        ? options.body.length > 0
          ? options.body
          : null
        : typeof options.body === 'string' && options.body.length > 0
          ? Buffer.from(options.body, 'utf8')
          : null;
      if (bodyBuf && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
        reqHeaders['Content-Length'] = String(bodyBuf.byteLength);
      }

      const requestOptions: https.RequestOptions = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : isHttps ? 443 : 80,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: reqHeaders,
        timeout: timeoutMs,
      };

      if (isHttps) {
        if (allowInsecureLocal) {
          requestOptions.rejectUnauthorized = false;
          requestOptions.checkServerIdentity = () => undefined;
        } else {
          requestOptions.rejectUnauthorized = true;
          if (caList) {
            requestOptions.ca = caList;
          }
        }
      }

      const transport = isHttps ? https : http;
      const req = transport.request(requestOptions, (res) => {
        const status = res.statusCode ?? 0;
        const normalizedHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') {
            normalizedHeaders[k.toLowerCase()] = v;
          } else if (Array.isArray(v) && v.length > 0) {
            normalizedHeaders[k.toLowerCase()] = v.join(', ');
          }
        }

        if (
          maxRedirects > 0 &&
          status >= 300 &&
          status < 400 &&
          normalizedHeaders.location
        ) {
          res.resume();
          const nextUrl = new URL(normalizedHeaders.location, rawUrl).toString();
          void requestWithLocalTlsPolicy(nextUrl, {
            ...options,
            method: status === 307 || status === 308 ? method : 'GET',
            body: status === 307 || status === 308 ? options.body : undefined,
            maxRedirects: maxRedirects - 1,
          })
            .then(resolve)
            .catch(reject);
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        const maxBytes = 4 * 1024 * 1024;
        res.on('data', (chunk: Buffer) => {
          if (totalBytes < maxBytes) {
            chunks.push(chunk);
            totalBytes += chunk.length;
          }
        });
        res.on('end', () => {
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: normalizedHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
            tlsBypassedForLocalSelfSigned: allowInsecureLocal,
          });
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`HTTP(S) Zeitüberschreitung nach ${timeoutMs} ms`));
      });
      req.on('error', (err) => {
        reject(err);
      });

      if (bodyBuf) {
        req.write(bodyBuf);
      }
      req.end();
    });

  // 1. Erst regulär mit System-CA + hochgeladenem NAS-Zertifikat versuchen
  try {
    return await attemptRequest(false);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? '';
    const msg = err instanceof Error ? err.message : String(err);
    const isCertError =
      isHttps &&
      (code.includes('CERT') ||
        code.includes('SSL') ||
        code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
        code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
        code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        msg.toLowerCase().includes('certificate') ||
        msg.toLowerCase().includes('self-signed') ||
        msg.toLowerCase().includes('self signed'));

    // 2. Nur im lokalen Heimnetz-Modus (und nur für LAN/FRITZ!Box-Hosts) selbstsignierte Zertifikate akzeptieren
    if (isCertError && allowLocalSelfSignedTls && isLocalHost) {
      const resp = await attemptRequest(true);
      return {
        ...resp,
        tlsBypassedForLocalSelfSigned: true,
        tlsCertificateError: msg,
      };
    }

    throw err;
  }
}
