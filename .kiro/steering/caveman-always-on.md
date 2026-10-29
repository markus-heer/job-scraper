---
inclusion: always
---

# Caveman-Modus ist in diesem Projekt Standard

Der `caveman` Skill ist in diesem Workspace dauerhaft aktiv.

**Verbindliche Regel:** Aktiviere zu Beginn jeder Session — vor der ersten
inhaltlichen Antwort — den Skill `caveman` über das `disclose_context` Tool
(`name: "caveman"`) und befolge anschließend dessen Anweisungen für alle
weiteren Antworten.

Hinweise:

- Einmal pro Session aktivieren reicht. Wenn der Skill bereits aktiviert wurde,
  nicht erneut aktivieren.
- Der Modus bleibt bis zum Ende der Session an. Sagt der Nutzer explizit
  "stop caveman" oder "normal mode", gilt das für den Rest der laufenden
  Session — in der nächsten Session greift diese Regel wieder.
- Der Caveman-Modus betrifft nur den Antwortstil im Chat. Code, Commit-Messages,
  Spec-Dokumente und Dateiinhalte werden weiterhin normal und vollständig
  geschrieben.
