import json, subprocess, sys, select, time, os
p = subprocess.Popen(['/home/lyt/.local/bin/codex','app-server','--listen','stdio://'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open('.tmp-probe.err','w'), text=True, bufsize=1)
def send(o):
    p.stdin.write(json.dumps(o)+'\n'); p.stdin.flush()
def recv(t=10):
    r,_,_=select.select([p.stdout],[],[],t)
    if not r: return ('TIMEOUT', None)
    line=p.stdout.readline()
    return ('LINE', line)
print('send init', flush=True)
send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'clientInfo':{'name':'probe','version':'0.1'}}})
print('init resp', recv(15), flush=True)
for i,tid in enumerate(['01a17b2c-13d7-7ce2-bd03-dc58f94a502b'], start=2):
    print('send read', tid, flush=True)
    send({'jsonrpc':'2.0','id':i,'method':'thread/read','params':{'threadId':tid}})
    st,line=recv(15)
    print('read status', st, flush=True)
    if line:
        try:
            d=json.loads(line)
            t=d.get('result',{}).get('thread',{})
            print(json.dumps({'model':t.get('model'),'effort':t.get('reasoningEffort'),'status':t.get('status'),'name':t.get('name')}, ensure_ascii=False), flush=True)
        except Exception as e:
            print('parse', e, line[:500], flush=True)
p.terminate(); time.sleep(1); p.kill()
