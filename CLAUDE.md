# CLAUDE.md

## GitHub: PR target

Questo repo è fork di `fiscaltec/vitally-mcp`. `gh pr create` di default
targetta l'upstream, non il nostro fork. **Sempre** passare `--repo`:

```
gh pr create --repo Wiseair-srl/vitally-mcp --base main ...
```

Stessa cosa per `gh pr list`, `gh pr view`, `gh pr close`, ecc.: aggiungi
`--repo Wiseair-srl/vitally-mcp` o il default sarà fiscaltec.

Una PR aperta per errore su fiscaltec non è cancellabile via API
(`deletePullRequest` non esiste): resta nello storico anche dopo close.
