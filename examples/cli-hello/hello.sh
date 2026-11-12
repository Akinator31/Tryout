#!/bin/sh
cat <<MSG
Welcome to a Tryout sandbox.
 - fresh environment, destroyed when the session ends
 - no outbound network access
 - read-only filesystem, except /tmp
Try: uname -a ; id ; ls / ; timeout 3 bash -c 'echo > /dev/tcp/1.1.1.1/80' (should fail)
MSG
