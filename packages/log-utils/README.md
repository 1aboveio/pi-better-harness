# log-utils

Small, dependency-free primitives for safely tailing large append-only logs.
It intentionally does not define capture or retention policy; callers retain
ownership of their log format and lifecycle guarantees.