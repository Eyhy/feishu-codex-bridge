import json, subprocess, select
p = subprocess.Popen(['/home/lyt/.local/bin/codex','app-server','--listen','stdio://'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
def send(o): p.stdin.write(json.dumps(o)+'\n'); p.stdin.flush()
def recv(t=15):
    r,_,_=select.select([p.stdout],[],[],t)
    if not r: return None
    return json.loads(p.stdout.readline())
send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'clientInfo':{'name':'probe','version':'0.1'}}}); recv()
send({'jsonrpc':'2.0','id':2,'method':'thread/read','params':{'threadId':'01a17b2c-13d7-7ce2-bd03-dc58f94a502b'}})
d=recv()
print('top keys', d.keys())
res=d.get('result',{})
print('result keys', res.keys())
t=res.get('thread') or {}
print('thread keys', sorted(t.keys()))
print(json.dumps({k:t.get(k) for k in ['id','name','model','reasoningEffort','status','cwd','canAcceptDirectInput','createdAt','updatedAt']}, ensure_ascii=False, indent=1))
p.terminate()
