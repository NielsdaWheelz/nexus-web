"""Linux child lifetime binding, armed before importing its workload.

``arm_parent_death_signal`` invokes the kernel's ``PR_SET_PDEATHSIG`` prctl
operation, which delivers the given signal to this process when its parent dies.
"""

import ctypes
import signal
import sys

_PR_SET_PDEATHSIG = 1


def arm_parent_death_signal() -> None:
    if sys.platform != "linux":
        return
    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    prctl.restype = ctypes.c_int
    if prctl(_PR_SET_PDEATHSIG, ctypes.c_ulong(signal.SIGKILL), 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "child parent-death signal could not be armed")
