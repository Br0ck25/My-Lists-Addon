# Python equivalent of build.ps1: header + numbered split files, byte-exact.
#
# The header used to be recovered by searching the EXISTING combined file for
# the current contents of 00_constants.js and keeping everything before it.
# That made the build self-referential: editing 00_constants.js broke the
# search, and the build then refused to run at all ("could not locate
# 00_constants.js inside the existing combined file"). It also meant the
# header had no source file, so a direct edit to it inside the generated
# Worker was invisible to the CI drift check. It now comes from header.js
# like every other input.
#
# assemble() is what check_sync.py compares the committed Worker against, so
# the two cannot disagree about how the file is made.
import glob
import hashlib

# The one place in the sources that carries it: WORKER_BUILD in 00_constants.js.
STAMP_PLACEHOLDER = b'"__BUILD_STAMP__"'


def assemble():
    """Return (worker bytes with the build stamp filled in, the stamp)."""
    out = bytearray(open('header.js', 'rb').read())
    for f in sorted(glob.glob('[0-9][0-9]_*.js')):
        data = open(f, 'rb').read()
        out += data
        # LF, not CRLF. This separator only fires for a source that does not end
        # with a newline, so it was a single stray CRLF in an otherwise-LF file --
        # invisible to verify.sh and CI (both ignore CR at EOL) but enough to make
        # check_sync.py's byte-exact compare fail on a clean checkout. See
        # .gitattributes.
        if not data.endswith(b'\n'):
            out += b'\n'
    if out.count(STAMP_PLACEHOLDER) != 1:
        raise SystemExit("build stamp placeholder must appear exactly once (WORKER_BUILD in 00_constants.js)")
    # Hash of the sources as written, line endings normalised, so the stamp is
    # the same on every platform.
    stamp = hashlib.sha256(bytes(out).replace(b'\r\n', b'\n')).hexdigest()[:10]
    return bytes(out).replace(STAMP_PLACEHOLDER, b'"' + stamp.encode() + b'"'), stamp


if __name__ == '__main__':
    data, stamp = assemble()
    open('worker_entry_combined.js', 'wb').write(data)
    print("header bytes:", len(open('header.js', 'rb').read()))
    print("combined bytes:", len(data))
    print("build stamp:", stamp, "(shown on /admin after you paste this file)")
