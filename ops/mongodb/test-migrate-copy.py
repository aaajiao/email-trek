#!/usr/bin/env python3
"""Local pure-function tests; no Docker/database invocation."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('migration', ROOT / 'migrate-copy.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
checks = []
def test(name, function):
    function(); checks.append({'name': name, 'passed': True})
def reject(function):
    try: function()
    except AssertionError: return
    raise AssertionError('Expected refusal')
test('traversal source subpath refused', lambda: reject(lambda: m.relative_path('../source')))
test('absolute source subpath refused', lambda: reject(lambda: m.relative_path('/source')))
test('empty source component refused', lambda: reject(lambda: m.relative_path('source//db')))
test('volume comma injection refused', lambda: reject(lambda: m.volume_name('x,readonly')))
test('readonly source mount', lambda: m.mount({'type': 'volume', 'value': 'source'}, '/source', True).endswith(',readonly') or (_ for _ in ()).throw(AssertionError()))
test('Linux volume subdirectory mapping', lambda: 'volume-subpath=db' in m.mount({'type': 'volume', 'value': 'copy'}, '/data/db', subpath='db') or (_ for _ in ()).throw(AssertionError()))
test('six pinned stages include original baseline', lambda: m.VERSIONS == ['4.4.2','4.4.30','5.0.33','6.0.28','7.0.45','8.0.34'] or (_ for _ in ()).throw(AssertionError()))
base = {'collections': {'d.c': {'type':'collection','count':2,'contentSha256':'a','naturalSha256':'b','indexesSha256':'c','capped':True,'cappedMax':'100000','validation':{'valid':True,'warningCount':0}}},'usersRoles':{'admin.system.users':{'count':1,'contentSha256':'secret-hash'}}}
test('identical collection and auth invariants accepted', lambda: m.compare_content(base, copy.deepcopy(base)))
for field in ['count','contentSha256','naturalSha256','indexesSha256','cappedMax']:
    def changed(field=field):
        other=copy.deepcopy(base);other['collections']['d.c'][field]='changed';reject(lambda:m.compare_content(base,other))
    test('changed '+field+' rejected',changed)
def auth_changed():
    other=copy.deepcopy(base);other['usersRoles']['admin.system.users']['contentSha256']='changed';reject(lambda:m.compare_content(base,other))
test('auth user hash change rejected',auth_changed)
def validation_warning():
    other=copy.deepcopy(base);other['collections']['d.c']['validation']['warningCount']=1;reject(lambda:m.compare_content(base,other))
test('validation warnings require review',validation_warning)
preimage = {'type':'collection','optionsSha256':m.PREIMAGES_OPTIONS_SHA256,
 'indexesSha256':m.PREIMAGES_INDEXES_SHA256,'indexCount':1,'uuidSha256':'0'*64,
 'capped':False,'cappedMax':None,'cappedBytes':None,'count':0,'rawBsonBytes':0,
 'contentSha256':m.EMPTY_SHA256,'naturalSha256':m.EMPTY_SHA256,
 'validation':{'valid':True,'warningCount':0}}
def with_preimage():
    result=copy.deepcopy(base);result.update(serverVersion='6.0.28',fcv='6.0')
    result['collections'][m.PREIMAGES]=copy.deepcopy(preimage);return result
test('exact new empty FCV6 internal collection accepted',lambda:m.compare_content(base,with_preimage()) == [m.PREIMAGES] or (_ for _ in ()).throw(AssertionError()))
for field,value in [('count',1),('rawBsonBytes',10),('contentSha256','changed'),('naturalSha256','changed'),('indexCount',2),('indexesSha256','wrong'),('optionsSha256','wrong'),('capped',True),('cappedMax','100'),('type','view'),('uuidSha256',None),('validation',{'valid':False,'warningCount':0}),('validation',{'valid':True,'warningCount':1})]:
    def altered(field=field,value=value):
        other=with_preimage();other['collections'][m.PREIMAGES][field]=value
        reject(lambda:m.compare_content(base,other))
    test('new pre-images altered '+field+' refused',altered)
def wrong_version():
    other=with_preimage();other.update(serverVersion='5.0.33',fcv='5.0');reject(lambda:m.compare_content(base,other))
test('pre-images exception refused before Mongo6',wrong_version)
def wrong_fcv():
    other=with_preimage();other['fcv']='5.0';reject(lambda:m.compare_content(base,other))
test('pre-images exception refused before FCV6',wrong_fcv)
def extra_namespace():
    other=with_preimage();other['collections']['config.unreviewed']=copy.deepcopy(preimage);reject(lambda:m.compare_content(base,other))
test('other added internal namespace refused',extra_namespace)
def removed_namespace():
    other=with_preimage();del other['collections']['d.c'];reject(lambda:m.compare_content(base,other))
test('removed original namespace refused',removed_namespace)
def existing_preimage_changed():
    original=with_preimage();other=copy.deepcopy(original);other['collections'][m.PREIMAGES]['uuidSha256']='1'*64
    reject(lambda:m.compare_content(original,other))
test('pre-existing pre-images metadata remains strict',existing_preimage_changed)
def existing_preimage_content_changed():
    original=with_preimage();other=copy.deepcopy(original);other['collections'][m.PREIMAGES]['contentSha256']='changed'
    reject(lambda:m.compare_content(original,other))
test('pre-existing pre-images content remains strict',existing_preimage_content_changed)
restart_stage={'version':'6.0.28','image_id':m.IMAGE_IDS[3],'entry_fcv':'5.0','exit_fcv':'6.0','shell':'mongosh'}
def restart_fixture(mode='ok'):
    calls=[];state={'id':'fixture','active_container':'stage'};args=SimpleNamespace(audit=Path('/not-used'))
    storage={'target':{'type':'volume','value':'new-target'}}
    def stop(name):
        calls.append(('stop',name))
        if mode=='unclean':raise AssertionError('unclean')
        return {'clean':True,'exitCode':0,'oomKilled':False}
    def persist(path,value):calls.append(('persist',path.name,copy.deepcopy(value)))
    def command(argv):calls.append(('command',argv));return b''
    def start(got_args,got_spec,got_stage,got_state):
        assert got_args is args and got_spec is storage and got_stage is restart_stage and got_state is state
        calls.append(('start',got_stage['image_id']));state['active_container']='stage'
        return 'stage'
    def shell(name,binary,command):
        calls.append(('fcv',name,binary,command))
        return {'ok':1,'version':'5.0' if mode=='wrongFCV' else '6.0'}
    with patch.object(m,'stop_database',stop),patch.object(m,'atomic',persist),patch.object(m,'checked',command),patch.object(m,'start_database',start),patch.object(m,'shell_command',shell):
        if mode!='ok':reject(lambda:m.restart_after_fcv(args,storage,restart_stage,state,'stage'))
        else:
            name,receipt=m.restart_after_fcv(args,storage,restart_stage,state,'stage')
            assert name=='stage' and receipt['restarted'] and receipt['recoveredFCV']['version']=='6.0'
            assert receipt['sameBinary'] and receipt['sameTarget'] and not receipt['repairUsed']
    return calls
def restart_order():
    calls=restart_fixture()
    assert [r[0] for r in calls]==['stop','persist','command','persist','start','fcv','persist']
    assert calls[2][1]==['docker','rm','stage']
    assert calls[1][2]['shutdown']['clean'] and calls[3][2]['active_container'] is None
test('FCV restart persists clean stop then removes then starts same target and binary',restart_order)
test('FCV restart refuses unexpected recovered FCV',lambda:restart_fixture('wrongFCV'))
def refuse_unclean_restart():
    calls=restart_fixture('unclean');assert [r[0] for r in calls]==['stop']
test('unclean stop never removes or starts a replacement',refuse_unclean_restart)
def refuse_no_upgrade_restart():
    stage=dict(restart_stage,entry_fcv='6.0')
    with patch.object(m,'stop_database',side_effect=RuntimeError('Must not stop')):
        reject(lambda:m.restart_after_fcv(None,None,stage,{},'stage'))
test('patch-only unchanged FCV has no intermediate restart',refuse_no_upgrade_restart)
test('Python3.10 syntax',lambda:ast.parse((ROOT/'migrate-copy.py').read_text(),feature_version=(3,10)))
report={'passed':True,'count':len(checks),'productionConnections':0,'databaseStarted':False,'checks':checks}
(ROOT/'migration-offline-tests.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'passed':True,'count':len(checks),'productionConnections':0}))
