import tkinter as tk, sys
r=tk.Tk(); r.withdraw(); r.clipboard_clear(); r.clipboard_append(sys.argv[1]); r.update()
r.after(15000, r.destroy); r.mainloop()
