# Releasing View Patch

How to publish View Patch to the Visual Studio Code (VS Code) Marketplace, and optionally to Open VSX, the registry
that VS Code-compatible editors such as VSCodium use.

## One-time setup

1. Create an empty public repository named `vscode-view-patch` under the `waddahmoghram` GitHub account, then push:

   ```bash
   git remote add origin https://github.com/waddahmoghram/vscode-view-patch.git
   git push -u origin main
   ```

1. Sign in to the [Marketplace publisher page](https://marketplace.visualstudio.com/manage) with a Microsoft account and
   create a publisher whose identifier is `waddahmoghram`, the `publisher` value in `package.json`. The identifier
   cannot be changed later.
1. On that publisher, open **Trusted Publishing** and create a policy, so the Publish workflow can sign in without a
   stored token:

   | Field            | Value               |
   | ---------------- | ------------------- |
   | Repository owner | `waddahmoghram`     |
   | Repository       | `vscode-view-patch` |
   | Workflow         | `publish.yml`       |
   | Environment      | leave empty         |

1. Optional, for Open VSX:
   1. Create an [eclipse.org account](https://accounts.eclipse.org/user/register) with your GitHub user name filled in.
   1. Sign in to [open-vsx.org](https://open-vsx.org) with GitHub, link the Eclipse account, and sign the Publisher
      Agreement from your profile page.
   1. Create an access token on the open-vsx.org **Access Tokens** page, then create the namespace once:

      ```bash
      npx ovsx create-namespace waddahmoghram -p <token>
      ```

   1. Save the token as the repository secret `OVSX_PAT`. The Publish workflow skips Open VSX when it is not set.

## First release

The version in `package.json` is 0.1.0, an odd minor version, so publish it as a pre-release first:

1. Run the Publish workflow by hand, as described under [Pre-releases](#pre-releases).
1. Install it from the Marketplace with **Switch to Pre-Release Version** on the extension page in VS Code, and try it.
1. Publish 0.2.0 as the first regular release, following [Each release](#each-release).

## Each release

1. Set `version` in `package.json` and add a section for it to `CHANGELOG.md`. The Marketplace accepts only
   `major.minor.patch` versions.
1. Commit, tag, and push. For version 0.2.0:

   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```

1. The Publish workflow checks that the tag matches `package.json`, runs the tests, publishes the package, and creates
   a GitHub release with the `.vsix` file attached.

## Pre-releases

Run the Publish workflow by hand from the **Actions** tab, from `main`, with **Publish as a pre-release** checked. A
pre-release needs a version number of its own. The Marketplace documentation suggests odd minor versions for
pre-releases (0.3.x) and even ones for releases (0.2.x), because VS Code moves users to the highest version available.

## Checking a package locally

```bash
npm ci
npm test
npx vsce package
npx vsce ls
```

On Linux without a display, run the tests as `xvfb-run -a npm test`. `npx vsce ls` lists the files that go into the
package.
