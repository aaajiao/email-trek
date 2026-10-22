#!/usr/bin/env python3
"""Run on host. Local TLS requests only. Malformed JSON rejects before routes,
so these checks never verify/send mail or request business database pages.
"""
import collections, concurrent.futures, http.client, json, socket, ssl, time
BOT='bot-gluttony.com';MAIL='email-trek.t-h-e-s-p-a-c-e.com'
class LocalHTTPS(http.client.HTTPSConnection):
    def connect(self):
        raw=socket.create_connection(('127.0.0.1',443),timeout=self.timeout)
        self.sock=self._context.wrap_socket(raw,server_hostname=self.host)
def request(host,path,method='GET',body=None,extra=None):
    connection=LocalHTTPS(host,timeout=10,context=ssl.create_default_context())
    headers={'Content-Type':'application/json','Connection':'close'}
    if extra:headers.update(extra)
    try:
        connection.request(method,path,body=body,headers=headers)
        response=connection.getresponse();status=response.status;response.read(65536);return status
    except Exception as e:return 'ERROR:'+type(e).__name__
    finally:connection.close()
def burst(host,path,n):
    started=time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(n,60)) as pool:
        statuses=list(pool.map(lambda i:request(host,path,'POST','{',{'X-Real-IP':'198.51.100.'+str(i%250+1),'X-Forwarded-For':'203.0.113.'+str(i%250+1)}),range(n)))
    return {'requests':n,'statuses':dict(collections.Counter(str(x) for x in statuses)),'duration_seconds':round(time.time()-started,3)}
result={'method':'Loopback HTTPS with original Host/SNI; invalid JSON, invalid login and oversized bodies only; no mail sent/verified or business pagination.'}
result['body_limits']={
    'login':request(BOT,'/api/auth/login','POST',json.dumps({'padding':'x'*9000})),
    'mail':request(MAIL,'/mail-you-send','POST',json.dumps({'padding':'x'*5000})),
    'data':request(MAIL,'/get-data','POST',json.dumps({'padding':'x'*5000})),
}
result['invalid_login']=request(BOT,'/api/auth/login','POST',json.dumps({'username':'maintenance-invalid-no-account','password':'maintenance-invalid-not-a-secret'}))
result['login_burst']=burst(BOT,'/api/auth/login',9)
result['mail_burst']=burst(MAIL,'/mail-you-send',9)
result['data_export_sized_burst']=burst(MAIL,'/get-data',50)
result['data_excess_burst']=burst(MAIL,'/get-data',70)
result['GET_not_rate_limited']={
    'login':request(BOT,'/api/auth/login'),'mail':request(MAIL,'/mail-you-send'),'data':request(MAIL,'/get-data')}
result['unrelated_pages']={'bot_home':request(BOT,'/'),'email_home':request(MAIL,'/'),'mail_page':request(MAIL,'/mail-you'),'svg_page':request(MAIL,'/svg')}
result['checks']={
 'all_body_caps_413':all(s==413 for s in result['body_limits'].values()),
 'invalid_login_rejected':result['invalid_login'] in (400,401,403),
 'login_excess_429':int(result['login_burst']['statuses'].get('429',0))>0,
 'mail_excess_429':int(result['mail_burst']['statuses'].get('429',0))>0,
 'export_50_not_throttled':result['data_export_sized_burst']['statuses']=={'400':50},
 'data_excess_429':int(result['data_excess_burst']['statuses'].get('429',0))>0,
 'forged_IP_headers_do_not_bypass_limits':all(int(result[k]['statuses'].get('429',0))>0 for k in ['login_burst','mail_burst','data_excess_burst']),
 'GET_methods_exempt':all(s!=429 and isinstance(s,int) for s in result['GET_not_rate_limited'].values()),
 'normal_pages_200':all(s==200 for s in result['unrelated_pages'].values()),
}
result['pass']=all(result['checks'].values())
print(json.dumps(result))
