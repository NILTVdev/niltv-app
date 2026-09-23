# Contributing

Thanks for helping build NIL TV. This file covers the ground rules; the README
covers setup and how to run the tests.

## Workflow

1. Fork the repository (or create a branch if you have write access) from the
   default branch.
2. Keep pull requests small and focused: one change, one PR, with a title that
   says what changed.
3. Make sure CI is green. The workflows run the test suite and a secret scan on
   every pull request.
4. A maintainer reviews and merges. Squash merges are the norm, so commit
   granularity inside a PR does not matter much.

## What a change should look like

- Follow the conventions already in the file you are editing (formatting,
  naming, the doc comment style). If the repository has a CONVENTIONS or
  DEVELOPING document, read it first.
- Add or update tests for behaviour changes.
- Do not commit secrets, tokens, credentials or `.env` files. The pre-commit
  hook and CI run gitleaks; if the scan flags something, fix it rather than
  allowlisting it.
- Do not add real people's data to fixtures or tests. Use obviously synthetic
  names, `example.com` addresses and 555 phone numbers.
- Do not name individuals in code comments, docs or commit messages. State the
  rule and its reason; leave out dates and incident history.
- Media, logos and data files are not code: do not add athlete photos, brand
  logos or exports to the repository. Ask a maintainer where they belong.

## Commit messages

Describe the change and why it was made. Keep the subject under about 70
characters. Do not describe internal incidents, people, or what was removed
from the repository.

## Reporting bugs

Open an issue with the steps to reproduce, what you expected and what
happened. For anything security-related, see SECURITY.md instead.

## License

By contributing you agree that your contributions are licensed under the MIT
License in the LICENSE file.
