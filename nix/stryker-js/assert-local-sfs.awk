BEGIN { bad = 0; skip = 0 }
/^[^ \t]/ { skip = ($0 ~ /^patchedDependencies:/) }
!skip { if (match($0, /@systemfsoftware\/[^@ \t]*@[0-9][^ \t]*/)) { printf "%s:%d: %s\n", FILENAME, FNR, substr($0, RSTART, RLENGTH); bad = 1 } }
END { exit bad }
