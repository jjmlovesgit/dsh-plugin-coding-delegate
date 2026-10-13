# Releasing the plugin to npm

Tags seal git history; `npm publish` pushes a permanent tarball to consumers. They are separate
operations with separate failure modes, and this file records the ones that actually bit us.

## The sequence

```powershell
# 1. Interactive login. This is the step that makes the rest work.
npm login --auth-type=web

# 2. Confirm the identity the session is acting as. It must print your account name.
npm whoami

# 3. Publish from plugin/. No --otp, and no token on the command line.
Set-Location plugin
npm publish --access public
Set-Location ..

# 4. Verify the registry, and that it matches the tag.
npm view dsh-plugin-coding-delegate version
npm view dsh-plugin-coding-delegate dist-tags
```

If npm wants a one-time password it prints its own `Enter OTP:` prompt during the publish. Type the
six digits from the authenticator there.

## Why the interactive form, and not the flags

Two attempts failed on the same field, `otp`, for two different reasons. Both are avoidable, and both
were avoidable only by logging in interactively.

**A token is not a one-time password.** `npm publish --otp=npm_...` is rejected by the registry before
anything is written:

```
E400  child "otp" fails because ["otp" with value "npm_***" fails to match the required pattern: /^\d+$/]
```

`--otp` takes the six-digit code. Nothing else. The registry's schema is the authority here: the field
is validated as digits and a token never matches.

**A valid token is not authority to write.** With 2FA in `auth-and-writes` mode, a perfectly good token
in `.npmrc` still gets:

```
EOTP  This operation requires a one-time password from your authenticator.
```

The token authenticates *who* you are; the account's 2FA mode decides whether a write is permitted with
that alone. `npm whoami` printing your name therefore proves less than it looks: it passes while the
publish is still refused. An **Automation** token (Access Tokens → Generate New Token → Automation) is
the exception, and is the right choice for CI, because bypassing that prompt is its entire purpose. A
granular token needs the **Bypass 2FA** permission to do the same.

`npm login` writes a session token over the `_authToken` line in `%USERPROFILE%\.npmrc`. It **replaces**
what is there rather than adding alongside it, so an Automation token kept in that file will be clobbered
by an interactive login. Keep a CI token in its own config and pass it explicitly with
`npm --userconfig=<path>`, or re-add it afterwards.

## Verifying what was published

Do not stop at `dist-tags`. Two facts are worth checking, and one of them is not obvious.

`gitHead` in the registry metadata is the commit npm recorded at publish time. It must equal the tag:

```powershell
npm view dsh-plugin-coding-delegate@0.5.2 gitHead
git rev-parse 'v0.5.2^{commit}'
```

Stronger, and the check that actually proves the artifact: download the published tarball and compare
each file against the tagged tree by **Git blob hash**. Comparing hashes this way avoids every
line-ending and encoding trap that hash-of-a-string comparisons fall into:

```powershell
$tmp = Join-Path $env:TEMP ("npmverify-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $tmp | Out-Null
Set-Location $tmp
npm pack dsh-plugin-coding-delegate@0.5.2
tar -xzf (Get-ChildItem -Filter *.tgz | Select-Object -First 1).Name

$pkg = Join-Path $tmp 'package'
foreach ($f in Get-ChildItem -Recurse -File $pkg) {
  $rel = $f.FullName.Substring($pkg.Length + 1).Replace('\', '/')
  $published = git -C C:\Projects\DSHLaya hash-object $f.FullName
  $tagged = git -C C:\Projects\DSHLaya rev-parse "v0.5.2:plugin/$rel"
  if ($published -ne $tagged) { Write-Output "DIFFERS: $rel" }
}
```

For v0.5.2 that reported 55 files compared, 55 identical. Comparing `dist.unpackedSize` and
`dist.fileCount` against `npm pack --dry-run` in `plugin/` is a faster smoke check -- 633729 bytes and 55
files on both sides -- but it cannot tell you the bytes are the same, only that the count is.

**The shasum is not reproducible across re-packs.** npm embeds file timestamps, so a tarball built from
an unchanged tree at a later moment can hash differently. Compare a published shasum against a fresh
`npm pack` of the same tree only when nothing has been touched in between; otherwise use the blob-hash
comparison above, which depends on content alone.

## When something goes wrong

**Nothing was published is the normal failure state.** Both errors above fail before the write, so the
registry is untouched and the version number is not spent. Confirm rather than assume: `npm view
<package>@<version> version` should answer E404 for a version that was never written.

**A token that has been displayed anywhere is compromised.** Replacing it in `.npmrc` does **not** revoke
it: the old value stays valid on the account until it is deleted, and anything holding it can publish.
Revoke in Access Tokens, issue a replacement, and remember that a token pasted after `--otp=` also lands
in shell history.

**Never paste a one-time password into a shared transcript, an issue, or an agent session.** It is live
for about thirty seconds, so a round trip through anything but your own terminal will usually miss the
window -- less safe and less likely to work than running the command yourself.
