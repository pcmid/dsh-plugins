import test from 'node:test'
import assert from 'node:assert/strict'
import {renderTextMentions,postText,legacyPostText} from '../host/mention-text.js'

const scope={tenantId:'tenant',recipientId:'ou_me'}
const self={key:'@_user_1',id_type:'open_id',id:scope.recipientId,tenant_key:scope.tenantId}
const other={key:'@_user_10',name:'$&@_user_1'}
test('plain text uses complete keys once per message, including adjacent CJK, with literal replacement names',()=>{
  const text='先@_user_1问@_user_10、@_user_1ありがとう；@_user_100，@_user_1x @_user_10_end $'
  assert.equal(renderTextMentions(text,[self,other],scope),'先@你问@$&@_user_1、@你ありがとう；@_user_100，@_user_1x @_user_10_end $')
  assert.equal(renderTextMentions('@_user_10',[self],scope),'@_user_10')
  assert.equal(renderTextMentions('@_user_1',[{...self,name:'阿零'}],{...scope,recipientName:'本人'}),'@阿零')
  assert.equal(renderTextMentions('@_user_1',[self],{...scope,recipientName:'本人'}),'@本人')
  for (const rows of [[],[{...self,id:'ou_other'}],[{...self,tenant_key:'else'}],[{...self,id_type:'user_id'}],
    [{...self,key:''}],[self,{...self,id:'ou_other',name:'different'}]])
    assert.equal(renderTextMentions('@_user_1',rows,scope),'@_user_1')
})
test('post rendering resolves actual at nodes only; text, title, code, URLs and old post spelling stay intact',()=>{
  const body={title:'@_user_1',content:[[{tag:'at',user_id:'@_user_1'},{tag:'text',text:'@_user_1'},
    {tag:'code_block',text:'@_user_10'},{tag:'a',text:'link',href:'https://test.invalid/@_user_1'}],
    [{tag:'at',user_id:'@_user_10'},{tag:'at',user_id:'unmapped',user_name:'inline'}]]}
  assert.equal(postText(body,[self,other],scope),'@_user_1\n@你@_user_1@_user_10[link](https://test.invalid/@_user_1)\n@$&@_user_1@inline')
  assert.equal(legacyPostText({content:[[{tag:'at',user_id:self.key,user_name:'old inline'},{tag:'at',user_id:other.key}]]},
    [{...self,name:'new name'},other]),'@old inline@$&@_user_1')
})
