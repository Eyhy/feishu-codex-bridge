import json, subprocess, select, sys
ids=sys.argv[1:]
p = subprocess.Popen(['/home/lyt/.local/bin/codex','app-server','--listen','stdio://'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
def send(o): p.stdin.write(json.dumps(o)+'\n'); p.stdin.flush()
def recv_for(i,t=20):
    import time
    end=time.time()+t
    while time.time()<end:
        r,_,_=select.select([p.stdout],[],[],max(0,end-time.time()))
        if not r: return None
        line=p.stdout.readline()
        if not line: return None
        d=json.loads(line)
        if d.get('id')==i: return d
    return None
send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'clientInfo':{'name':'probe','version':'0.1'}}}); recv_for(1)
for i,tid in enumerate(ids,start=2):
    send({'jsonrpc':'2.0','id':i,'method':'thread/read','params':{'threadId':tid}})
    d=recv_for(i)
    if not d: print(json.dumps({'id':tid,'error':'timeout'})); continue
    if 'error' in d: print(json.dumps({'id':tid,'error':d['error']}, ensure_ascii=False)); continue
    res=d.get('result',{})
    t=res.get('thread') or {}
    print(json.dumps({'id':tid,'resultKeys':list(res.keys()),'threadKeys':sorted(t.keys())[:25],'model':t.get('model'),'effort':t.get('reasoningEffort'),'name':t.get('name'),'status':t.get('status'),'cwd':t.get('cwd'),'canAcceptDirectInput':t.get('canAcceptDirectInput')}, ensure_ascii=False))
p.terminate()
