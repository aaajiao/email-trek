# Maintenance conventions

- Preserve the artwork's typography, colors, layout and character-based home view. Repair interactions without redesigning it.
- SVG exports must contain the complete stored email addresses, with correct XML escaping. The home Socket stream remains graphical.
- Keep cumulative historical statistics and a bounded recent window of 100,000 records. Historical SMTP labels are observations, not proof that mailboxes exist or messages were delivered.
- Preserve representative historical samples and statistics before retiring old detail data. Never publish samples, live configuration, credentials or maintenance state to GitHub.
- Keep security and recovery tests offline or use explicitly isolated synthetic database fixtures. Do not send real email as a test without an authorized recipient.
- Synchronize production source, deployment recipes and maintenance changes with this repository, and record the verified deployment revision. Do not leave permanent fixes only inside a running container.
- Keep certificate renewal and bounded log rotation. Do not add alerting or scheduled monitoring without a new request.
