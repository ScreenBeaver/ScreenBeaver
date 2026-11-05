# Secrets policy

Never commit real `.env` files, API keys, tokens, or certificates.

- Use `.env.example` for placeholder names only.
- Rotate any key that was ever committed, then rewrite history if needed (`git filter-repo`) — deleting in a new commit is not enough.
- Enable GitHub **secret scanning** and **push protection** for this repo (Settings → Code security).

To scan the public history locally before a release:

```bash
# example with gitleaks (install separately)
gitleaks detect --source . --verbose
```
