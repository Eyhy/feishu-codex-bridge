import importlib.util
spec = importlib.util.spec_from_file_location('x', '.tmp-x11.py')
x = importlib.util.module_from_spec(spec); spec.loader.exec_module(x)
x.click(900,1048)
x.key('a', ctrl=True)
time = __import__('time'); time.sleep(.3)
x.key('Delete')
