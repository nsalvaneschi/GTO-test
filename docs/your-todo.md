# Things only you can do

## Must do (blocks going live)
1. **Deploy on Railway** (steps in `server/README.md`): New Project > Deploy from GitHub repo `nsalvaneschi/GTO-test` (branch `claude/gto-poker-agent-params-d6odfd`, or merge to main first) > Add Volume mounted at `/data` > Generate Domain > keep 1 replica. No variables needed.
2. **If the first build fails, send me the build log.** The Dockerfile has never been built (no Docker in my environment); it compiles `wasm-bindgen-cli`, so the first build is slow.
3. **Check the live app on your own phone (Safari/iPhone and Android Chrome).** I could only test Chromium. Look for: solve works, page does not scroll sideways, drills run, login works, WASM does not crash on iOS memory limits. Tell me what breaks.
4. **Secrets:** never paste tokens or passwords in chat. Put Railway/Docker credentials only in their own dashboards. If I need a key, I will ask through a secure form.

## Needed to make the content trustworthy
5. **Real hand histories:** export `.txt` from your own PokerStars/GGPoker account (check each site's help for the export steps) and attach them to a session. They go to `private-data/handhistories/` (git-ignored). I run `npm run hh:check` and report counts only.
6. **A reference solver export (a sample):** from a solver you own (PioSolver, GTO Wizard export if your plan allows, etc.) as CSV/text, to `private-data/reference/`. I write the converter and compare against our solver. Do not send anything you are not licensed to use.
7. **Decide what the app may claim.** Preflop strategies and hand-history range presets are NOT validated against a real solver. Until they are, keep the 'approximate' labels and do not market it as exact GTO.
8. **Native-speaker review of Spanish and Italian terms:** `docs/i18n-review.md` (regenerate with `cd web && npm run i18n:review`). Fill the reviewer columns or send me the fixes.

## Legal and product (your call)
9. **Name and branding:** I used 'GTO Trainer' and an original design. Do not use 'GTO Wizard' or its logo/assets. Check that the name is free to use.
10. **Privacy notice and terms** (the app stores accounts and optionally hand histories; if you serve users in the EU/Italy/Spain, GDPR applies). Delete-my-data exists in the app. You need a short privacy policy and a contact address.
11. **Poker-site rules:** most sites ban real-time assistance during play. Position the app as a study tool and say so in the terms.
12. **Repo licence:** choose one. I bundled no third-party solver code.
13. **Backups and cost:** decide on Railway volume backups for the SQLite database, and watch the Railway plan's cost.
14. **Merging:** I never opened a pull request. Tell me when you want one, or merge the branch yourself.
