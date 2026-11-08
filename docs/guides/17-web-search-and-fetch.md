# 17. Web Search and Web Fetch

OpenRouter can give the assistant two built-in web tools. They are independent, **off by
default**, and can add provider charges on top of the model call.

| Variable | `enable` | `disable` |
| --- | --- | --- |
| `AI_WEB_SEARCH` | The assistant may search the web for current information. | The search tool is not sent. |
| `AI_WEB_FETCH` | The assistant may fetch a URL and read its page or PDF content. | The fetch tool is not sent. |

Set each variable to `enable` or `disable`. The fallback chain uses the same two
settings; changing the model does not change them. `AI_REASONING` is separate and still
applies per model.

These switches control OpenRouter's built-in server tools. The existing
`researchInventoryProducts` and `researchMarketPrices` tools have their own
`AI_ALLOW_PAID_WEB_SEARCH` gate and keyless search fallback. `AI_WEB_SEARCH_URL` is also
separate: it is the keyless research endpoint, not this switch.

## Copy a setup

Both tools on:

```bash
AI_WEB_SEARCH=enable
AI_WEB_FETCH=enable
```

Search only:

```bash
AI_WEB_SEARCH=enable
AI_WEB_FETCH=disable
```

Fetch only:

```bash
AI_WEB_SEARCH=disable
AI_WEB_FETCH=enable
```

Both off (the default):

```bash
AI_WEB_SEARCH=disable
AI_WEB_FETCH=disable
```

## Apply and verify

1. Put the two lines in `server/.env`.
2. Restart the server so it reads the file again.
3. Run:

   ```bash
   cd server
   npm run ai:check
   ```

   The output includes the effective state, for example:

   ```text
   [ai:check] web tools : search enabled, fetch disabled
   ```

4. Open the assistant and try the capability:

   - Search: **“Search the web for the latest version of this product and cite the sources.”**
   - Fetch: **“Fetch https://example.com and summarize the page.”**

   A successful turn returns current search results or the fetched page's content. If the
   tool is disabled, it is not sent to OpenRouter, so the assistant cannot use that
   capability on the turn.

An invalid value makes `npm run ai:check` exit 1 and name the variable. The server also
keeps the tool disabled and logs a warning at boot; it never turns a paid tool on because
of a typo.

`AI_WEB_SEARCH` and `AI_WEB_FETCH` are optional. Leave either one out to use its default,
which is `disable`.
