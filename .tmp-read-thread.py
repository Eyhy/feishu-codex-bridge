import json, subprocess, sys, time
ids = sys.argv[1:]
p = subprocess.Popen(['/home/lyt/.local/bin/codex','app-server','--listen','stdio://'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
def send(obj):
    p.stdin.write(json.dumps(obj)+'\n'); p.stdin.flush()
def recv():
    line = p.stdout.readline()
    if not line: raise SystemExit('eof: '+p.stderr.read())
    return json.loads(line)
send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'clientInfo':{'name':'probe','version':'0.1'}}})
print('init', recv())
for i,tid in enumerate(ids, start=2):
    send({'jsonrpc':'2.0','id':i,'method':'thread/read','params':{'threadId':tid}})
    r=recv()
    t=r.get('result',{}).get('thread',{})
    print(json.dumps({'id':tid,'model':t.get('model'),'effort':t.get('reasoningEffort'),'status':t.get('status'),'name':t.get('name'),'cwd':t.get('cwd'),'canAcceptDirectInput':t.get('canAcceptDirectInput')}, ensure_ascii=False))
p.terminate()
