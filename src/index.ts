interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Peppol participant lookup (SML + SMP + Peppol Directory).
 *
 * Peppol is the EU e-invoicing network. Discovery is a two-hop, keyless,
 * fully public protocol and this pack walks it live on every call:
 *
 *   1. SML (Service Metadata Locator) — a DNS lookup. Peppol uses OASIS BDXL:
 *      the record name is the unpadded base32 of SHA-256 over the lowercased
 *      participant identifier, under `iso6523-actorid-upis.<SML zone>`, and the
 *      record is a NAPTR whose service field is "Meta:SMP" and whose regexp
 *      field carries the participant's SMP base URL.
 *
 *      This matters because the OLDER scheme — an MD5 hash with a `B-` prefix
 *      resolving to a CNAME — is what most write-ups still describe, and it
 *      NXDOMAINs for every participant today. If you get NXDOMAIN for a
 *      participant you can see in the Peppol Directory, you are on the MD5
 *      path, not looking at an unregistered company.
 *
 *   2. SMP (Service Metadata Publisher) — plain HTTPS against the URL the
 *      NAPTR handed back. `GET {smp}/{scheme}::{id}` returns a ServiceGroup
 *      listing every document type the participant accepts; appending
 *      `/services/{docTypeId}` returns the AS4 endpoint and transport profile
 *      for one of them.
 *
 * The Workers runtime has no DNS resolver, so step 1 goes over DNS-over-HTTPS
 * (Cloudflare, falling back to Google). The two return NAPTR RDATA in slightly
 * different shapes — Cloudflare quotes the character-strings, Google does not —
 * so the parser tolerates both.
 *
 * Search comes from the Peppol Directory (directory.peppol.eu), the network's
 * own opt-in business-card index, operated by OpenPEPPOL. Not every registered
 * participant publishes a business card, so a name search missing someone is
 * not evidence they are off the network — `lookup_participant` against the SML
 * is the authoritative check.
 *
 * All three upstreams are keyless and need no Peppol network membership.
 */


const UA = 'pipeworx-mcp-peppol/1.0 (+https://pipeworx.io)';

async function pwFetch(url: string | URL, upstream: string, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, upstream);
}

/** Production SML zone, and the pilot/test one, both operated by the European Commission. */
const SML_ZONES: Record<string, string> = {
  production: 'edelivery.tech.ec.europa.eu',
  test: 'acc.edelivery.tech.ec.europa.eu',
};

const DEFAULT_SCHEME = 'iso6523-actorid-upis';
const DIRECTORY = 'https://directory.peppol.eu';

/**
 * SMP implementations disagree on content negotiation for the same documents:
 * smp.elma-smp.no (Spring) answers 406 to `Accept: application/xml` while
 * smp.horus-software.be serves it, and both accept `text/xml`. Send a list, or
 * the pack works against one operator's SMP and 406s against another's.
 */
const SMP_ACCEPT = 'text/xml, application/xml;q=0.9, */*;q=0.8';

const tools: McpToolExport['tools'] = [
  {
    name: 'lookup_participant',
    description:
      'Check whether a company is registered on the Peppol e-invoicing network and list every document type it accepts. Resolves the participant identifier through the Peppol SML (DNS/BDXL) to its SMP, then reads the SMP ServiceGroup — the authoritative registration check, keyless, no Peppol membership needed. Returns registered=false with the reason when the identifier has no SML record. Use search_participants first if you have a company name rather than an identifier.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        participantId: {
          type: 'string',
          description:
            'Peppol participant identifier as "{schemeCode}:{value}", e.g. "0208:1021916675" (Belgian company number), "0192:989995278" (Norwegian org number), "0088:7300010000001" (GLN). The leading 4-digit schemeCode is an ICD code and is part of the identifier. A bare VAT/org number without it will not resolve — find the right form with search_participants.',
        },
        scheme: {
          type: 'string',
          description: 'Identifier scheme. Effectively always the default "iso6523-actorid-upis"; only override for a non-standard network.',
        },
        environment: {
          type: 'string',
          description: '"production" (default) queries the live Peppol network. "test" queries the pilot SML (acc.edelivery.tech.ec.europa.eu).',
        },
      },
      required: ['participantId'],
    },
  },
  {
    name: 'get_participant_endpoint',
    description:
      'Get the AS4 delivery details a sender needs for one specific document type: transport profile, receiving endpoint URL, process identifier, and the service activation/expiration window. Call lookup_participant first to get the exact documentTypeId to pass here. An expired ServiceExpirationDate means the participant is listed but that document type is no longer deliverable.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        participantId: { type: 'string', description: 'Peppol participant identifier, e.g. "0192:989995278".' },
        documentTypeId: {
          type: 'string',
          description:
            'Full document type identifier value exactly as lookup_participant returned it in documentTypes[].value, e.g. "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1".',
        },
        documentTypeScheme: { type: 'string', description: 'Document type scheme, default "busdox-docid-qns".' },
        scheme: { type: 'string', description: 'Participant identifier scheme, default "iso6523-actorid-upis".' },
        environment: { type: 'string', description: '"production" (default) or "test".' },
      },
      required: ['participantId', 'documentTypeId'],
    },
  },
  {
    name: 'search_participants',
    description:
      'Search the Peppol Directory (directory.peppol.eu, OpenPEPPOL\'s opt-in business-card index) by company name, VAT/organisation number or country to find a participant identifier. Use this to turn a company name into the "{schemeCode}:{value}" identifier that lookup_participant needs. Registration on the network does not require publishing a business card, so absence here is not proof a company is not on Peppol — confirm with lookup_participant.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        q: { type: 'string', description: 'Free-text query: company name, VAT number, or organisation number, e.g. "Atelier OSLO" or "1021916675".' },
        country: { type: 'string', description: 'Optional 2-letter ISO country code filter, e.g. "NO", "BE", "DE".' },
        limit: { type: 'number', description: 'Max matches to return, 1-100. Default 10.' },
      },
      required: ['q'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'lookup_participant':
      return lookupParticipant(args);
    case 'get_participant_endpoint':
      return getParticipantEndpoint(args);
    case 'search_participants':
      return searchParticipants(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- SML (BDXL)

/**
 * BDXL record name: unpadded base32(SHA-256(lowercased identifier value)).
 * The hash input is the identifier VALUE only ("0208:1021916675"), never the
 * "iso6523-actorid-upis::" prefix — including the prefix silently NXDOMAINs.
 */
async function bdxlHostname(participantId: string, scheme: string, zone: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(participantId.toLowerCase()));
  return `${base32(new Uint8Array(digest))}.${scheme}.${zone}`;
}

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out; // unpadded, per BDXL
}

interface DohAnswer {
  Status: number;
  Answer?: Array<{ type: number; data: string }>;
}

/**
 * Resolve the NAPTR over DNS-over-HTTPS. Cloudflare first, Google as fallback:
 * a single DoH provider is a single point of failure for the whole pack, and
 * these are the two that serve NAPTR as JSON.
 */
async function resolveNaptr(hostname: string): Promise<{ records: string[]; status: number; resolver: string }> {
  const resolvers = [
    { url: `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=NAPTR`, headers: { Accept: 'application/dns-json' }, name: 'Cloudflare DNS-over-HTTPS' },
    { url: `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=NAPTR`, headers: { Accept: 'application/json' }, name: 'Google DNS-over-HTTPS' },
  ];
  let lastErr: unknown;
  for (const r of resolvers) {
    try {
      const res = await pwFetch(r.url, r.name, { headers: r.headers });
      if (!res.ok) throw await httpError(res, r.name);
      const body = (await res.json()) as DohAnswer;
      const records = (body.Answer ?? []).filter((a) => a.type === 35).map((a) => a.data);
      return { records, status: body.Status ?? -1, resolver: r.name };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Peppol SML: DNS-over-HTTPS lookup of ${hostname} failed on every resolver: ${String(lastErr)}`);
}

/**
 * Pull the SMP base URL out of a NAPTR RDATA string. Handles both DoH shapes:
 *   Cloudflare: 100 10 "U" "Meta:SMP" "!.*!https://smp.example/!" .
 *   Google:     100 10 U Meta:SMP !.*!https://smp.example/! .
 * Only "Meta:SMP" records are ours; a zone may carry other services.
 */
function smpUrlFromNaptr(rdata: string): string | null {
  if (!/Meta:SMP/i.test(rdata)) return null;
  const m = rdata.match(/!\.\*!(https?:\/\/[^!"\s]+)!/);
  return m ? m[1] : null;
}

/**
 * The SMP URL arrives from DNS, so treat it as untrusted input before we fetch
 * it: HTTPS only, and never a loopback/link-local/private host. The SML is
 * authoritative for the network, but that is not a reason to let a record point
 * this Worker at something internal.
 */
function assertSafeSmpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Peppol SML returned an SMP address that is not a URL: ${raw.slice(0, 120)}`);
  }
  if (url.protocol !== 'https:') throw new Error(`Peppol SMP address is not HTTPS: ${raw.slice(0, 120)}`);
  const host = url.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^\[?(::1|::|fc00:|fd|fe80:)/i.test(host) ||
    /^(10|127|0)\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new Error(`Peppol SMP address resolves to a non-public host and was not fetched: ${host}`);
  return url;
}

// ---------------------------------------------------------------- SMP (HTTPS)

/** SMP path form is `{scheme}::{value}`, percent-encoded whole. */
function encodedParticipant(scheme: string, participantId: string): string {
  return encodeURIComponent(`${scheme}::${participantId}`);
}

/**
 * Minimal, namespace-agnostic XML reads. SMPs differ in prefix (`smp:` vs
 * `ns2:` vs none) for the same elements, so everything matches on local name.
 */
function attrValues(xml: string, localName: string, attr: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*?\\b${attr}\\s*=\\s*"([^"]*)"`, 'g');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(m[1]);
  return out;
}

function elementTexts(xml: string, localName: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${localName}>`, 'g');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(m[1].trim());
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Split a busdox document type value into its parts. Shape is
 * `{rootNamespace}::{localName}##{customizationId}::{ublVersion}` — the
 * customizationId is the part that tells you WHICH profile (e.g. Peppol BIS
 * Billing 3.0) rather than merely which UBL document.
 */
function describeDocumentType(value: string): { rootNamespace?: string; localName?: string; customizationId?: string; version?: string } {
  const hashIdx = value.indexOf('##');
  if (hashIdx < 0) return {};
  const left = value.slice(0, hashIdx);
  const right = value.slice(hashIdx + 2);
  const leftSep = left.lastIndexOf('::');
  const rightSep = right.lastIndexOf('::');
  return {
    rootNamespace: leftSep >= 0 ? left.slice(0, leftSep) : left,
    localName: leftSep >= 0 ? left.slice(leftSep + 2) : undefined,
    customizationId: rightSep >= 0 ? right.slice(0, rightSep) : right,
    version: rightSep >= 0 ? right.slice(rightSep + 2) : undefined,
  };
}

// ---------------------------------------------------------------- tools

function normalizeParticipant(args: Record<string, unknown>): { participantId: string; scheme: string; zone: string; environment: string } {
  const participantId = reqStr(args, 'participantId', '"0192:989995278"').trim();
  const scheme = optStr(args, 'scheme') ?? DEFAULT_SCHEME;
  const environment = (optStr(args, 'environment') ?? 'production').toLowerCase();
  const zone = SML_ZONES[environment];
  if (!zone) throw new Error(`Unknown environment "${environment}". Use "production" or "test".`);
  if (!/^[A-Za-z0-9]+:.+/.test(participantId)) {
    throw new Error(
      `participantId "${participantId}" is not in "{schemeCode}:{value}" form. Peppol identifiers carry a 4-digit ICD prefix, e.g. "0192:989995278" (Norwegian org number) or "0208:1021916675" (Belgian company number). Use search_participants to find the right form.`,
    );
  }
  return { participantId, scheme, zone, environment };
}

async function resolveSmp(participantId: string, scheme: string, zone: string) {
  const hostname = await bdxlHostname(participantId, scheme, zone);
  const { records, status, resolver } = await resolveNaptr(hostname);
  const smpUrl = records.map(smpUrlFromNaptr).find((u): u is string => Boolean(u)) ?? null;
  return { hostname, records, status, resolver, smpUrl };
}

async function lookupParticipant(args: Record<string, unknown>): Promise<unknown> {
  const { participantId, scheme, zone, environment } = normalizeParticipant(args);
  const { hostname, status, resolver, smpUrl } = await resolveSmp(participantId, scheme, zone);

  if (!smpUrl) {
    // NXDOMAIN (status 3) is the network's own "no such participant". Anything
    // else that yielded no Meta:SMP record is a lookup problem, not an answer,
    // and is reported as such rather than as an unregistered company.
    const notFound = status === 3;
    return {
      participantId,
      scheme,
      environment,
      registered: false,
      reason: notFound
        ? 'No SML record — this participant identifier is not registered on the Peppol network.'
        : `SML lookup returned DNS status ${status} with no Meta:SMP NAPTR record; registration could not be determined.`,
      determinate: notFound,
      smlHostname: hostname,
      resolver,
      documentTypes: [],
      documentTypeCount: 0,
      source: `Peppol SML (${zone}) via ${resolver}`,
    };
  }

  const base = assertSafeSmpUrl(smpUrl);
  const url = `${base.origin}${base.pathname.replace(/\/$/, '')}/${encodedParticipant(scheme, participantId)}`;
  const res = await pwFetch(url, 'Peppol SMP', { headers: { Accept: SMP_ACCEPT } });
  if (res.status === 404) {
    return {
      participantId,
      scheme,
      environment,
      registered: false,
      reason: `The SML points at ${base.host} but that SMP returns 404 for this participant — the DNS record is stale or the participant was removed.`,
      determinate: true,
      smlHostname: hostname,
      smpUrl: base.origin,
      documentTypes: [],
      documentTypeCount: 0,
      source: `Peppol SMP at ${base.host}`,
    };
  }
  if (!res.ok) throw await httpError(res, `Peppol SMP ${base.host}`);
  const xml = await res.text();

  // Each ServiceMetadataReference href ends in the percent-encoded
  // `{docTypeScheme}::{docTypeValue}` for one accepted document type.
  const documentTypes = attrValues(xml, 'ServiceMetadataReference', 'href')
    .map((href) => {
      const marker = '/services/';
      const idx = href.lastIndexOf(marker);
      if (idx < 0) return null;
      let raw = href.slice(idx + marker.length);
      try {
        raw = decodeURIComponent(raw);
      } catch {
        /* leave as-is if the SMP double-encoded it */
      }
      const sep = raw.indexOf('::');
      const dtScheme = sep >= 0 ? raw.slice(0, sep) : 'busdox-docid-qns';
      const value = sep >= 0 ? raw.slice(sep + 2) : raw;
      return { scheme: dtScheme, value, ...describeDocumentType(value) };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

  return {
    participantId: decodeEntities(elementTexts(xml, 'ParticipantIdentifier')[0] ?? participantId),
    scheme,
    environment,
    registered: true,
    determinate: true,
    smlHostname: hostname,
    smpUrl: base.origin,
    smpHost: base.host,
    documentTypeCount: documentTypes.length,
    documentTypes,
    source: `Peppol SML (${zone}) via ${resolver}, then the SMP at ${base.host}`,
  };
}

async function getParticipantEndpoint(args: Record<string, unknown>): Promise<unknown> {
  const { participantId, scheme, zone, environment } = normalizeParticipant(args);
  const documentTypeId = reqStr(args, 'documentTypeId', '"urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1"').trim();
  const documentTypeScheme = optStr(args, 'documentTypeScheme') ?? 'busdox-docid-qns';

  const { smpUrl } = await resolveSmp(participantId, scheme, zone);
  if (!smpUrl) throw new Error(`${participantId} has no SML record — it is not registered on the Peppol ${environment} network, so it has no endpoints. Check with lookup_participant.`);

  const base = assertSafeSmpUrl(smpUrl);
  const url = `${base.origin}${base.pathname.replace(/\/$/, '')}/${encodedParticipant(scheme, participantId)}/services/${encodeURIComponent(`${documentTypeScheme}::${documentTypeId}`)}`;
  const res = await pwFetch(url, 'Peppol SMP', { headers: { Accept: SMP_ACCEPT } });
  if (res.status === 404) {
    throw new Error(`The SMP at ${base.host} does not publish document type "${documentTypeId}" for ${participantId}. Call lookup_participant and copy an exact value from documentTypes[].value.`);
  }
  if (!res.ok) throw await httpError(res, `Peppol SMP ${base.host}`);
  const xml = await res.text();

  // One <Process> may carry several <Endpoint>s; flatten to one row each and
  // keep the process identifier alongside, since a sender needs both.
  const endpoints: Array<Record<string, unknown>> = [];
  for (const proc of elementTexts(xml, 'Process')) {
    const processId = decodeEntities(elementTexts(proc, 'ProcessIdentifier')[0] ?? '');
    const processScheme = attrValues(proc, 'ProcessIdentifier', 'scheme')[0] ?? '';
    for (const ep of elementTexts(proc, 'Endpoint')) {
      const expiration = elementTexts(ep, 'ServiceExpirationDate')[0];
      const expired = expiration ? Date.parse(expiration) < Date.now() : false;
      endpoints.push({
        processId,
        processScheme,
        transportProfile: attrValues(proc, 'Endpoint', 'transportProfile')[0] ?? null,
        endpointUrl: decodeEntities(elementTexts(ep, 'Address')[0] ?? ''),
        requireBusinessLevelSignature: elementTexts(ep, 'RequireBusinessLevelSignature')[0] === 'true',
        serviceActivationDate: elementTexts(ep, 'ServiceActivationDate')[0] ?? null,
        serviceExpirationDate: expiration ?? null,
        expired,
        hasCertificate: elementTexts(ep, 'Certificate').length > 0,
      });
    }
  }

  return {
    participantId,
    documentTypeId,
    documentTypeScheme,
    environment,
    smpHost: base.host,
    endpointCount: endpoints.length,
    deliverable: endpoints.some((e) => e.expired === false && e.endpointUrl),
    endpoints,
    source: `Peppol SMP at ${base.host}`,
  };
}

interface DirectoryMatch {
  participantID?: { scheme?: string; value?: string };
  docTypes?: Array<{ scheme?: string; value?: string }>;
  entities?: Array<{ name?: Array<{ name?: string; language?: string }>; countryCode?: string; identifiers?: Array<{ scheme?: string; value?: string }>; regDate?: string }>;
}

async function searchParticipants(args: Record<string, unknown>): Promise<unknown> {
  const q = reqStr(args, 'q', '"Atelier OSLO"').trim();
  const country = optStr(args, 'country');
  const limitRaw = typeof args.limit === 'number' ? args.limit : 10;
  const limit = Math.min(100, Math.max(1, Math.trunc(limitRaw)));

  // The Directory takes its filters inside `q` as `key=value` terms; a bare
  // term is a free-text name/identifier match.
  const terms = country ? `${q} country=${country}` : q;
  const url = `${DIRECTORY}/search/1.0/json?q=${encodeURIComponent(terms)}&rpc=${limit}`;
  const res = await pwFetch(url, 'Peppol Directory', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw await httpError(res, 'Peppol Directory');
  const body = (await res.json()) as { 'total-result-count'?: number; matches?: DirectoryMatch[] };

  const matches = (body.matches ?? []).map((m) => {
    const entity = m.entities?.[0];
    return {
      participantId: m.participantID?.value ?? null,
      scheme: m.participantID?.scheme ?? DEFAULT_SCHEME,
      name: entity?.name?.[0]?.name ?? null,
      countryCode: entity?.countryCode ?? null,
      registrationDate: entity?.regDate && entity.regDate !== '0001-01-01' ? entity.regDate : null,
      identifiers: (entity?.identifiers ?? []).map((i) => ({ scheme: i.scheme ?? null, value: i.value ?? null })),
      documentTypeCount: m.docTypes?.length ?? 0,
      documentTypes: (m.docTypes ?? []).map((d) => ({ scheme: d.scheme ?? null, value: d.value ?? null })),
    };
  });

  return {
    query: q,
    country: country ?? null,
    totalResultCount: body['total-result-count'] ?? matches.length,
    returned: matches.length,
    matches,
    note: 'Business cards in the Peppol Directory are opt-in, so a company absent here may still be registered — confirm with lookup_participant.',
    source: 'Peppol Directory (directory.peppol.eu), operated by OpenPEPPOL',
  };
}

// ---------------------------------------------------------------- args

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
