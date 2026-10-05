# Third party notices

Relay's original source is licensed under AGPL-3.0-only. The dependencies below retain their own licenses. `npm ci` installs them, and the prepare script copies the browser libraries without modifying their license headers.

| Component | Locked version | License | Full notice |
| --- | --- | --- | --- |
| Marked | 16.4.2 | MIT, including the upstream Markdown notice | [Marked license](licenses/marked-LICENSE.md) |
| DOMPurify | 3.4.16 | Apache-2.0 option of the upstream dual license | [DOMPurify license](licenses/dompurify-Apache-2.0.txt) |
| Babel helpers embedded in DOMPurify | As distributed by DOMPurify | MIT | [Babel helpers license](licenses/babel-helpers-MIT.txt) |
| Trusted Types type definitions | 2.0.7, optional dependency | MIT | [Trusted Types license](licenses/trusted-types-MIT.txt) |

Marked is copyright MarkedJS and Christopher Jeffrey; its full notice also retains John Gruber's Markdown notice. DOMPurify is copyright Cure53 and other contributors. The embedded Babel helpers retain their upstream Sebastian McKenzie, contributor, and Facebook notices.

External model providers, search feeds, and returned content are governed by their respective terms; they are not relicensed by this repository.
