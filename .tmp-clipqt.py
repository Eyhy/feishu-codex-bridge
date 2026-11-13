import sys
from PyQt5.QtWidgets import QApplication
from PyQt5.QtCore import QTimer
app=QApplication([])
app.clipboard().setText(sys.argv[1])
QTimer.singleShot(15000, app.quit)
app.exec_()
