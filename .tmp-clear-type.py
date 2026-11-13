import importlib.util
spec = importlib.util.spec_from_file_location('x', '.tmp-x11.py')
x = importlib.util.module_from_spec(spec); spec.loader.exec_module(x)
x.click(900,1048)
x.key('End')
for _ in range(80): x.key('BackSpace')
x.type_text('abc')
