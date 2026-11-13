import ctypes, sys, time
x11 = ctypes.cdll.LoadLibrary('libX11.so.6')
xtst = ctypes.cdll.LoadLibrary('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_uint
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
d = x11.XOpenDisplay(b':1')
if not d: raise SystemExit('no display')
def focus(w):
    x11.XRaiseWindow(d, int(w,16)); x11.XSetInputFocus(d, int(w,16), 1, 0); x11.XFlush(d); time.sleep(.2)
def move(x,y):
    xtst.XTestFakeMotionEvent(d, -1, int(x), int(y), 0); x11.XFlush(d)
def click(x,y):
    move(x,y); time.sleep(.1); xtst.XTestFakeButtonEvent(d,1,1,0); xtst.XTestFakeButtonEvent(d,1,0,0); x11.XFlush(d); time.sleep(.2)
def rclick(x,y):
    move(x,y); time.sleep(.1); xtst.XTestFakeButtonEvent(d,3,1,0); xtst.XTestFakeButtonEvent(d,3,0,0); x11.XFlush(d); time.sleep(.2)
def mclick(x,y):
    move(x,y); time.sleep(.1); xtst.XTestFakeButtonEvent(d,2,1,0); xtst.XTestFakeButtonEvent(d,2,0,0); x11.XFlush(d); time.sleep(.2)
def dclick(x,y):
    move(x,y); time.sleep(.1)
    for _ in range(2):
        xtst.XTestFakeButtonEvent(d,1,1,0); xtst.XTestFakeButtonEvent(d,1,0,0); time.sleep(.08)
    x11.XFlush(d); time.sleep(.2)
def key(name, ctrl=False, shift=False):
    ks = x11.XStringToKeysym(name.encode()); kc = x11.XKeysymToKeycode(d, ks)
    if ctrl: xtst.XTestFakeKeyEvent(d, x11.XKeysymToKeycode(d, x11.XStringToKeysym(b'Control_L')), 1, 0)
    if shift: xtst.XTestFakeKeyEvent(d, x11.XKeysymToKeycode(d, x11.XStringToKeysym(b'Shift_L')), 1, 0)
    xtst.XTestFakeKeyEvent(d, kc, 1, 0); xtst.XTestFakeKeyEvent(d, kc, 0, 0)
    if shift: xtst.XTestFakeKeyEvent(d, x11.XKeysymToKeycode(d, x11.XStringToKeysym(b'Shift_L')), 0, 0)
    if ctrl: xtst.XTestFakeKeyEvent(d, x11.XKeysymToKeycode(d, x11.XStringToKeysym(b'Control_L')), 0, 0)
    x11.XFlush(d); time.sleep(.05)
def type_text(s):
    for ch in s:
        if ch == ' ': key('space')
        elif ch == '/': key('slash')
        elif ch == '-': key('minus')
        elif ch == '.': key('period')
        elif ch == '_': key('underscore', shift=True)
        elif ch.isupper(): key(ch.lower(), shift=True)
        else: key(ch)

if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'focus': focus(sys.argv[2])
    elif cmd == 'click': click(int(sys.argv[2]), int(sys.argv[3]))
    elif cmd == 'rclick': rclick(int(sys.argv[2]), int(sys.argv[3]))
    elif cmd == 'mclick': mclick(int(sys.argv[2]), int(sys.argv[3]))
    elif cmd == 'dclick': dclick(int(sys.argv[2]), int(sys.argv[3]))
    elif cmd == 'key': key(sys.argv[2], ctrl='--ctrl' in sys.argv, shift='--shift' in sys.argv)
    elif cmd == 'type': type_text(sys.argv[2])
    elif cmd == 'enter': key('Return')
    elif cmd == 'tab': key('Tab')
    elif cmd == 'esc': key('Escape')

class _XClientMessageData(ctypes.Union):
    _fields_ = [('b', ctypes.c_char*20), ('s', ctypes.c_short*10), ('l', ctypes.c_long*5)]
class _XClientMessageEvent(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int), ('display', ctypes.c_void_p), ('window', ctypes.c_ulong), ('message_type', ctypes.c_ulong), ('format', ctypes.c_int), ('data', _XClientMessageData)]
class _XEvent(ctypes.Union):
    _fields_ = [('type', ctypes.c_int), ('xclient', _XClientMessageEvent), ('pad', ctypes.c_long*24)]
x11.XInternAtom.restype = ctypes.c_ulong
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
x11.XMapRaised.argtypes = [ctypes.c_void_p, ctypes.c_ulong]

def activate(w):
    wid = int(w,16)
    root = x11.XDefaultRootWindow(d)
    atom = x11.XInternAtom(d, b'_NET_ACTIVE_WINDOW', 0)
    ev = _XEvent()
    ev.xclient.type = 33
    ev.xclient.window = wid
    ev.xclient.message_type = atom
    ev.xclient.format = 32
    ev.xclient.data.l[0] = 1
    ev.xclient.data.l[1] = 0
    ev.xclient.data.l[2] = 0
    x11.XMapRaised(d, wid)
    x11.XSendEvent(d, root, 0, 0x1 | 0x2, ctypes.byref(ev))
    x11.XFlush(d)
    time.sleep(.4)
    x11.XSetInputFocus(d, wid, 1, 0)
    x11.XFlush(d)
    time.sleep(.3)
