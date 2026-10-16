# Comment moderation

How comments on videos are moderated, as the code implements it today. The App
Store rules for user-generated content (guideline 1.2) apply: a filter for
objectionable content, a way to report a comment, a way to block a user, staff
who can remove comments, and published contact information.

Minors use the app, so every rule below treats a user as a minor unless the
stored USER row says `is18plus` is exactly `true` (conventions: the row is the
source of truth, never live Cognito attributes). A missing value is a minor.

## Who can do what

| Action | Who | Notes |
|---|---|---|
| Read comments | Signed-in users | The list depends on who is asking (blocks, own held comments), so it is never cached at the edge. |
| Post | Signed-in users, any age | After accepting the community guidelines once. 500 characters. |
| Edit or delete | The author only | Someone else's comment answers 404. A comment hidden after reports cannot be edited. |
| Report | Signed-in users | Not your own comment. One report per user per comment. |
| Block | Signed-in users | Private and one-way. The blocked user is not told. |
| Approve, restore, remove | Staff only | `staff` group, checked in the handler. |

Names are shown as first name plus last initial ("Scott L."), for everyone.

## Limits

- 5 posts or edits per minute per user.
- The same text from the same user within 10 minutes is refused. The app shows
  the same "commenting too fast" message for this.
- Rejected attempts count toward the limit.

## The filter

One shared module, `@niltv/types/comment-filter`, built on the `obscenity`
library. The backend runs it on every post and every edit. The app runs the same
code in the composer so explicit text cannot be sent. The server is the
authority: the app check is feedback only.

| Result | What triggers it | What happens |
|---|---|---|
| Reject | Slurs and sexual terms (anything in the library's English dataset except the mild list), threat phrases such as telling someone to hurt themselves | 422, nothing stored. The message is generic and never says which rule matched. |
| Hold | Links, email addresses, phone numbers and `@handles`, for everyone. Mild swearing, for minors only | Stored as `pending`. Visible only to its author ("awaiting review") until staff approve it. |
| Allow | Everything else | Published. |

The mild list (ordinary swear words) lives in `types/src/comment-wordlist.ts`,
next to the threat phrases. Tests build their inputs from the library and that
file, so the repo holds no offensive text of its own.

This is a baseline keyword filter. It will miss creative spelling. Reports,
blocking and staff review are the real safety net.

## Reports

- Reasons: harassment, hate, sexual, violence, spam, other.
- The reporter stops seeing the comment immediately.
- At 3 distinct reporters the comment is hidden for everyone and joins the staff
  queue. Only staff can bring it back.

## Blocks

Blocking hides that user's comments from the blocker, at read time. Blocked users
are listed, and can be unblocked, under Profile, Blocked users.

## Staff (admin tool, Comments tab)

- **Held for review** and **Hidden by reports** queues, newest first, with minors'
  comments listed first. A per-clip lookup lists the visible and held comments on
  one clip (hidden ones appear in their own queue).
- **Approve** a held comment. **Restore** a hidden one (this resets its report
  count, so staff's decision stands).
- **Remove** needs a reason. Removal is a tombstone, never a delete (the same rule
  as content removal): the text is kept for audit, the comment drops off every
  list, and who removed it and why are recorded.

## Deleting

- An author deleting an unreported comment removes it. If it has reports, it
  becomes a tombstone with the text cleared, so staff history stays coherent.
- Deleting an account clears the text of the user's comments and anonymises the
  author. Reports the user filed on other comments are not removed (there is no
  index to find them without scanning the table).

## Still open

These need a decision or a real value before App Review. None of them is
guessed in the code.

| Item | State |
|---|---|
| Community guidelines page and a link to it | The app has only a short built-in summary. Set `EXPO_PUBLIC_GUIDELINES_URL` (https) when the page exists. Until then no link is shown. |
| Published contact information | Set `EXPO_PUBLIC_SUPPORT_EMAIL` to a monitored address. Until then no contact link is shown. |
| Alerting when comments are reported or hidden | None. Staff must open the Comments tab. Guideline 1.2 expects timely responses. |
| Response-time target for reports | None written down. |
| Rule for minors: hold mild swearing, allow it for adults | Proposed, not yet confirmed. The alternative is holding every minor's comment for review. |
| Rate limit of 5 per minute | Default, not yet confirmed. |
| A comment count on each clip | Not built. |
| Whether guests may read comments | Currently they may not (the list is per-user). |
