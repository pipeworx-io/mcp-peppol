# @pipeworx/peppol

Check whether a company is registered on the Peppol e-invoicing network, list
the document types it accepts, and get the AS4 endpoint a sender needs — walked
live through the Peppol SML and SMP, with no network membership required.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `lookup_participant(participantId, scheme?, environment?)` — the authoritative
  registration check. Resolves the participant through the SML (DNS/BDXL) to its
  SMP and reads the ServiceGroup. Answers "can I send this company an e-invoice,
  and in which formats?" Returns `registered: false` with a reason, plus
  `determinate`, when there is no SML record.
- `get_participant_endpoint(participantId, documentTypeId, documentTypeScheme?, scheme?, environment?)`
  — the AS4 delivery details for one document type: transport profile, receiving
  endpoint URL, process identifier, and the service activation/expiration
  window. Answers "where do I actually deliver this, and is it still live?"
- `search_participants(q, country?, limit?)` — searches the Peppol Directory by
  company name, VAT number or organisation number. Answers "what is this
  company's Peppol identifier?", which is the input the other two tools need.

## Auth

Keyless. All three upstreams are public and need no Peppol network membership,
no Access Point contract and no PKI certificate. Reading the network's discovery
layer is deliberately open — it is what lets any sender find any receiver.

(Note the asymmetry: *reading* discovery is open, *sending* over AS4 is not.
Delivering a document needs an accredited Access Point and a Peppol certificate.
This pack covers the read half only.)

## Data sources

- `https://cloudflare-dns.com/dns-query` and `https://dns.google/resolve` — the
  SML NAPTR lookup, over DNS-over-HTTPS because the Workers runtime has no DNS
  resolver. Cloudflare first, Google as fallback.
- SML zone `iso6523-actorid-upis.edelivery.tech.ec.europa.eu` (production) and
  `iso6523-actorid-upis.acc.edelivery.tech.ec.europa.eu` (pilot), operated by the
  European Commission — maps a participant identifier to its SMP base URL.
- Per-participant SMPs, whichever host the NAPTR names (e.g.
  `https://smp.elma-smp.no`, `https://smp.horus-software.be`) — serve
  `/{scheme}::{participantId}` and `/{scheme}::{participantId}/services/{docTypeId}`.
- `https://directory.peppol.eu/search/1.0/json` — the Peppol Directory, the
  network's opt-in business-card index, operated by OpenPEPPOL.

### Things worth knowing before you touch this

**The MD5 lookup scheme every write-up describes is dead.** Most Peppol
documentation (and most blog posts) describe the SML as
`B-{md5(lowercased participant id)}.iso6523-actorid-upis.{zone}` resolving to a
CNAME. That NXDOMAINs today for every participant, including ones you can see
listed in the Peppol Directory. The live scheme is OASIS BDXL: the record name is
the **unpadded base32 of SHA-256** over the lowercased identifier, and the record
is a **NAPTR** whose service field is `Meta:SMP` and whose regexp field carries
the SMP URL as `!.*!https://smp.example/!`. Getting NXDOMAIN on a company you
know is registered means you are on the MD5 path, not looking at an unregistered
company — that costs an hour if you trust the docs over a live dig.

**Hash the identifier value only.** The input to SHA-256 is `0192:989995278`,
never `iso6523-actorid-upis::0192:989995278`. Including the scheme prefix
NXDOMAINs silently, which looks exactly like "not registered".

**The two DoH providers return NAPTR RDATA in different shapes.** Cloudflare
quotes the character-strings (`100 10 "U" "Meta:SMP" "!.*!https://x!" .`), Google
does not (`100 10 U Meta:SMP !.*!https://x! .`). Parse both or the fallback path
silently returns nothing.

**SMPs disagree about `Accept`.** `smp.elma-smp.no` (Spring-based) answers
**406 Not Acceptable** to `Accept: application/xml`, while
`smp.horus-software.be` serves it. Both accept `text/xml`. Send a q-list, or the
pack works against one operator's SMP and 406s against another's — and a 406 here
reads like the participant is broken rather than like our header is.

**XML prefixes vary by SMP implementation.** The same elements come back as
`smp:ServiceGroup` from one operator and `ns2:ServiceGroup` from another. Match on
local name, never on prefix.

**Absence from the Directory is not absence from the network.** Business cards
are opt-in, so `search_participants` returning nothing does not mean a company
cannot receive e-invoices. `lookup_participant` against the SML is the
authoritative answer; the Directory is a convenience index for turning names into
identifiers.

**The participant identifier is `{icd}:{value}`, and the ICD prefix is part of
it.** `989995278` is a Norwegian org number; `0192:989995278` is a Peppol
participant. The same company can appear under several ICDs (e.g. `0208` company
number and `9925` VAT for the same Belgian entity), each a separate registration
with its own document types.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "peppol": {
      "url": "https://gateway.pipeworx.io/peppol/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/peppol/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "peppol": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-peppol"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-peppol
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Peppol data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
