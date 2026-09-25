# Compliance Register

Snapshot: 20 September 2026 · Base commit: 7b5d8e0 + pending working-tree changes
Reviewed by: GG Coder compliance-guard · **Engineering guidance, NOT LEGAL ADVICE**

## Scope and limits

This is a final check of the pending iOS submission/privacy changes, not a new
whole-product security or legal audit. Source claims were checked against push,
phone persistence and relay/envelope code. Apple and Expo guidance linked below
was retrieved on the snapshot date. App Store Connect answers, the uploaded IPA,
live delivery, native accessibility and signing/export paperwork were not
inspected. Existing broad-audit assertions that were not rechecked are marked
stale rather than carried forward as passes.

## Exposure profile

- **Confirmed from code:** no app accounts, payments, analytics or advertising;
  user controls agents on their own computer, not a public user-content platform.
- **Confirmed from code:** Expo/APNs receive push payloads and a delivery token;
  Cloudflare carries encrypted relay traffic and can see connection metadata;
  policy/support links open GitHub. Agent providers have separate data practices.
- **Assumed:** public international distribution, individual developer, real
  user data, under-18s possible with no age gate. Store configuration is not proof
  of actual territories, legal entity, filed age rating or live privacy labels.

## Coverage ledger

`open` means unverified, not a demonstrated defect. `stale` means the prior pass's
claim was not re-confirmed within this scoped review.

| # | Item | State | Evidence |
| --- | --- | --- | --- |
| 1 | Committed secrets / ignore gaps | stale | No new secret scan in this pass |
| 2 | Database access controls | n-a | No client-facing database in the reviewed change |
| 3 | Authorization | stale | No new authorization audit |
| 4 | Transport encryption | CODE | Sealed session frames; remote push is explicitly excepted |
| 4b | Secrets in shipped bundle | open | No IPA inspected |
| 5 | Public-surface rate limits | stale | No relay abuse review in this pass |
| 6 | Payment/inbound webhooks | n-a | None in this change |
| 7 | Object-storage permissions | n-a | None in this change |
| 8 | Dependency licences | open | No dependency added; no licence scan; AGPL does not automatically establish dependency compatibility |
| 9 | Policy accuracy | CODE — corrected locally | F1; public GitHub policy still dated 5 August 2026 at review time |
| 10 | Third-party disclosures | CODE — corrected locally | F2, F6 |
| 11 | Filed App Store privacy labels | open | F3; console not inspected |
| 12 | Tracking consent | n-a to this change | No tracking added |
| 13 | Marketing claims | CODE — corrected locally | F4 |
| 14 | Minors / age gate | fail — no age gate | F5; age rating and applicability still need owner review |
| 15 | AI transparency | open | Agent nature is explicit; no legal determination under AI legislation |
| 16 | US/EU/UK consumer contract duties | n-a to payment changes | No purchases or subscriptions in scope; not a legal conclusion about all free-service terms |
| 17 | US/EU/UK public-platform duties | n-a | No publishing or messaging between users in this product model |
| 18 | Accessibility — image alternatives | open | Store images visually inspected; whole-app assistive-technology behaviour not retested |
| 19 | Accessibility — labels | CODE | PrivacyLink has a link role and explicit label |
| 20a | Accessibility — keyboard operation | open | Native keyboard/VoiceOver not tested |
| 20b | Accessibility — contrast | measured, scoped | Privacy link #86868c: 5.22:1 on #111111, 4.70:1 on #1c1c1e at rest; not an app-wide result |
| 20c | Accessibility — focus visibility | open | Native focus not tested |
| 20d | Accessibility — media controls/captions | n-a to this change | No audio/video playback component added |
| 20e | Accessibility — page language | n-a to native link | External GitHub policy page not accessibility-audited |
| 21 | Shipped privacy manifest | open | Expo config resolves; presence of a generated local file is not verification of the shipped IPA |
| 22 | Export classification | open — owner/legal verification | A standard cipher alone does not prove exemption; existing Info.plist flag is unchanged |

## Findings

| ID | Severity | Trigger / evidence | Status / guard |
| --- | --- | --- | --- |
| F1 | HIGH | CODE — policy incorrectly promised no phone copies, all storage in Keychain, uninstall erasure, background-only push and immediate cessation after disabling notifications | Corrected locally: memory/cache/Photos, persistent Keychain entries, unconditional finished-turn push, and daemon restart needed to clear registered targets. Existing push tests pass; no live delivery test |
| F2 | HIGH | CODE — disclosure omitted push session identifier, described the opening rather than final message, and claimed delivery companies never received other data | Corrected locally; names Expo/APNs payload fields, relay metadata, agent providers and GitHub visits. Publish the policy before relying on it |
| F3 | MEDIUM | DEDUCED — live App Store privacy answers cannot be inferred from repo | Open. Apple defines collection as off-device transmission allowing access longer than needed for real-time service. Push alone does not establish collection; Expo says contents are transient. Verify all vendors' retention/access, including identifiers, before choosing labels. If reporting a device identifier, do not automatically mark it unlinked: Apple counts linkage through a device |
| F4 | MEDIUM | CODE — store copy said no server exists and nothing is collected; review notes limited push to a closed app | Corrected locally in description, promotional text and review notes; no App Store metadata uploaded |
| F5 | MEDIUM | CODE / DEDUCED — no age gate; the previous register asserted a filed 4+ rating without console evidence | Open owner review. Complete Apple's current questionnaire accurately; 26-era OS ratings include 4+, 9+, 13+, 16+, 18+, with older-OS mappings. Do not prescribe 4+ or add an arbitrary age gate solely because AI output is possible. `messagingAndChat` concerns communication between users, not this private agent conversation |
| F6 | MEDIUM | CODE — relay metadata disclosure incomplete | Corrected locally: IPs, device/session identifiers, counters, sizes and timing; no unsupported promise about Cloudflare infrastructure retention |
| F7 | LAWYER | DEDUCED — earlier register treated EAA applicability too broadly | Unresolved, not a finding that this free remote-control app is a covered service. Get jurisdiction/product-specific advice before asserting an accessibility exemption or legal compliance; developer/company facts are not in the repo |
| F8 | BACKLOG | CODE — earlier register claimed no private security reporting despite SECURITY.md | Closed as an incorrect finding: SECURITY.md names GitHub private vulnerability reporting. Live repository setting not verified |
| F9 | MEDIUM | CODE — privacy link silently swallowed browser-open failures | Implemented an accessible native error alert with retry/store-page guidance. Typecheck/lint pass; native failure path not exercised |

## Implemented in this pass

- Updated the public-policy draft to 20 September and aligned it with actual
  local storage, session transport and notification behaviour.
- Removed unsupported secrecy/server claims from store metadata and corrected
  reviewer notes. Kept the intentional iPhone-only configuration.
- Added visible error handling to the shared privacy link; no new dependency.
- Corrected this register's unsupported privacy-label, age-rating, export,
  security-contact and audit-pass claims.

## Verification

- `npm run typecheck` and `npm run lint`: passed.
- `bun test ./packages/app/src ./packages/daemon/src/push.test.ts ./packages/protocol/src/notice.test.ts`:
  460 passed, 0 failed. These do not prove native UI or live push behaviour.
- Expo public configuration resolved: portrait, iPhone-only, version 1.0.0.
- Metadata lengths checked: title 9/30, subtitle 27/30, promotional text 163/170,
  description 2476/4000, comma-joined keywords 96/100. App/store policy URLs match.
- All three PNGs visually inspected and measured at 1320×2868, an accepted Apple
  6.9-inch size. No new simulator screenshots or IPA build made in this pass.
- Public policy URL responded, but serves the older policy until these changes
  reach GitHub main. A local commit alone does not publish it.

## Open — release checks

1. Publish the corrected policy on GitHub main and verify the visible version;
   submit matching store metadata/privacy answers. Do not infer filed answers
   from this register.
2. Verify the uploaded app version/device families. If an existing App Store
   release supports iPad, do not assume an update may remove that support. The
   current change intentionally targets iPhone only; this review did not inspect
   prior uploads. Ensure reviewers have a working agent/machine to test, not
   just an unpaired first screen.
3. Before upload, test the privacy links and browser-error path on a device,
   confirm the finished-turn payload and disable/restart behaviour, and verify
   the release IPA's manifest/signing/export answers. No app release was made.

## Needs qualified advice

F7 and any export-classification uncertainty cannot be resolved by reading
Info.plist. Privacy-notice legal identity/contact requirements and territorial
obligations depend on actual operator facts, not assumptions in this repository.

## Sources re-read on 20 September 2026

- [Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — privacy policy in metadata and in-app, §5.1.1
- [Apple age ratings](https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/)
- [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
- [Expo push FAQ](https://docs.expo.dev/push-notifications/faq/) — contents held in memory/queues; debugging access possible
- [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/) — iOS Keychain entries may survive uninstall

Re-check these sources and console answers at submission; they are not a legal
certification or evidence that the current working tree is already released.
