#!/bin/sh
set -eu

MIN_SPACESD_MAJOR=0
MIN_SPACESD_MINOR=16
SUDOERS_PATH=/etc/sudoers.d/forge-mounts
PLIST_PATH=/Library/LaunchDaemons/dev.forge.spacesd.plist

fail() {
    printf 'provision-guest: %s\n' "$*" >&2
    exit 1
}

resolve_path() {
    resolve_target=$1
    case $resolve_target in
        /*) ;;
        *) resolve_target=$(cd "$(dirname "$resolve_target")" && pwd -P)/$(basename "$resolve_target") ;;
    esac
    while [ -L "$resolve_target" ]; do
        resolve_dir=$(cd "$(dirname "$resolve_target")" && pwd -P)
        resolve_link=$(readlink "$resolve_target")
        case $resolve_link in
            /*) resolve_target=$resolve_link ;;
            *) resolve_target=$resolve_dir/$resolve_link ;;
        esac
    done
    printf '%s/%s\n' "$(cd "$(dirname "$resolve_target")" && pwd -P)" "$(basename "$resolve_target")"
}

link_bin() {
    link_source=$1
    link_dest=/usr/local/bin/$2
    [ -x "$link_source" ] || fail "$link_source is missing after the Homebrew install"
    if [ "$link_source" = "$link_dest" ]; then
        return 0
    fi
    ln -sf "$link_source" "$link_dest" || fail "could not link $link_source into $link_dest"
}

install_formula() {
    formula=$1
    if ! sudo -u lume -H "$brew" list "$formula" >/dev/null 2>&1; then
        sudo -u lume -H "$brew" install "$formula" || fail "Homebrew failed to install $formula"
    fi
}

if [ "$(id -u)" -ne 0 ]; then
    fail "must run as root (sudo $0)"
fi

if ! id -u lume >/dev/null 2>&1; then
    fail "user 'lume' does not exist; run this inside a Cua macOS base VM"
fi

if ! command -v cua-spacesd >/dev/null 2>&1; then
    fail "cua-spacesd is not installed; install the Cua spacesd daemon (https://github.com/trycua/cua) inside this VM, then rerun this script"
fi

cua_spacesd_path=$(resolve_path "$(command -v cua-spacesd)")

if ! version_output=$("$cua_spacesd_path" --version 2>&1); then
    fail "could not read the version of $cua_spacesd_path"
fi
version_line=$(printf '%s\n' "$version_output" | grep -E '[0-9]+\.[0-9]+' | head -n 1)
version_major=$(printf '%s\n' "$version_line" | sed -n 's/^[^0-9]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1/p')
version_minor=$(printf '%s\n' "$version_line" | sed -n 's/^[^0-9]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\2/p')
if [ -z "$version_major" ] || [ -z "$version_minor" ]; then
    fail "could not parse a version from '$version_line'"
fi
if [ "$version_major" -gt "$MIN_SPACESD_MAJOR" ]; then
    :
elif [ "$version_major" -eq "$MIN_SPACESD_MAJOR" ] && [ "$version_minor" -ge "$MIN_SPACESD_MINOR" ]; then
    :
else
    fail "cua-spacesd $version_major.$version_minor is too old; $MIN_SPACESD_MAJOR.$MIN_SPACESD_MINOR or newer is required (upgrade cua-spacesd from https://github.com/trycua/cua, then rerun this script)"
fi

if [ -x /opt/homebrew/bin/brew ]; then
    brew=/opt/homebrew/bin/brew
elif [ -x /usr/local/bin/brew ]; then
    brew=/usr/local/bin/brew
else
    fail "Homebrew not found at /opt/homebrew/bin/brew or /usr/local/bin/brew; install it from https://brew.sh, then rerun this script"
fi

brew_prefix=$(sudo -u lume -H "$brew" --prefix) || fail "could not read the Homebrew prefix from $brew"

mkdir -p /usr/local/bin
install_formula ripgrep
install_formula node
link_bin "$brew_prefix/bin/rg" rg
link_bin "$brew_prefix/bin/node" node

lume_uid=$(id -u lume)

sudoers_tmp=$(mktemp /tmp/forge-sudoers.XXXXXX)
printf '%s\n' 'lume ALL=(root) NOPASSWD: /sbin/mount_virtiofs, /bin/mkdir, /usr/sbin/chown' >"$sudoers_tmp"
if ! visudo -cf "$sudoers_tmp"; then
    rm -f "$sudoers_tmp"
    fail "generated sudoers rule failed visudo validation"
fi
chown root:wheel "$sudoers_tmp"
chmod 0440 "$sudoers_tmp"
mv "$sudoers_tmp" "$SUDOERS_PATH"

plist_tmp=$(mktemp /tmp/forge-spacesd.XXXXXX)
cat >"$plist_tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>dev.forge.spacesd</string>
	<key>UserName</key>
	<string>lume</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>-c</string>
		<string>sudo -n /bin/mkdir -p /Volumes/forge-setup &amp;&amp; sudo -n /sbin/mount_virtiofs forge-setup /Volumes/forge-setup; exec $cua_spacesd_path --token-file /Volumes/forge-setup/env-token</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>StandardOutPath</key>
	<string>/var/log/forge-spacesd.log</string>
	<key>StandardErrorPath</key>
	<string>/var/log/forge-spacesd.log</string>
</dict>
</plist>
EOF
if ! plutil -lint "$plist_tmp"; then
    rm -f "$plist_tmp"
    fail "generated LaunchDaemon plist failed plutil -lint"
fi
chown root:wheel "$plist_tmp"
chmod 0644 "$plist_tmp"
mv "$plist_tmp" "$PLIST_PATH"

launchctl disable "system/com.trycua.spacesd" || true
launchctl bootout "system/com.trycua.spacesd" || true
launchctl disable "gui/$lume_uid/com.trycua.spacesd" || true
launchctl bootout "gui/$lume_uid/com.trycua.spacesd" || true

launchctl enable "system/dev.forge.spacesd" || fail "could not enable dev.forge.spacesd"
launchctl bootout "system/dev.forge.spacesd" || true
launchctl bootstrap system "$PLIST_PATH" || fail "could not bootstrap $PLIST_PATH"

systemsetup -f -setremotelogin off || fail "could not disable SSH with systemsetup -f -setremotelogin off"

dscl . -passwd /Users/lume

printf 'Done. Shut the VM down now and keep it as the Forge base VM (forge-macos-base).\n'
