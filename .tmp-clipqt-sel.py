import sys
from PyQt5.QtWidgets import QApplication
from PyQt5.QtCore import QTimer
app=QApplication([])
app.clipboard().setText(sys.argv[1], mode=app.clipboard().Clipboard)
app.clipboard().setText(sys.argv[1], mode=app.clipboard().Selection)
QTimer.singleShot(20000, app.quit)
app.exec_()
