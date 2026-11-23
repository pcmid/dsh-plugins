// A run is a projection of the last durable state, not an event log.
function spaceWorkSteps(message,tr) {
  const run=message.run, steps=[], system='SuperAgent', router=spaceRoleLabel('lead',tr), worker='DSH', channel=tr('飞书','Feishu');
  const add=(kind,who,zh,en,detail)=>{
    steps.push({kind,who,stage:tr(zh,en),...(detail?{detail}:{})});
  };
  if (!run) {
    switch (message.status) {
      case 'received': add('intake',system,'已收到消息','Message received');break;
      case 'dispatching': add('assignment',system,'正在提交至 DSH','Submitting to DSH');break;
      case 'submitted': add('assignment',system,'已交给 DSH','Submitted to DSH');break;
      case 'failed': add('stop',system,'提交失败','Submission failed');break;
      case 'uncertain': add('unknown',system,'未确认 DSH 是否接单','Handoff to DSH unconfirmed');break;
      default: add('unknown',system,'办理状态未知','Work status unknown');
    }
    return steps;
  }
  const {status,reason}=run,question=run.outputKind==='question';
  if (status==='queued') add('decision',router,'等待判断','Awaiting assessment');
  else if (status==='deciding') add('decision',router,'正在判断是否办理','Assessing the request');
  else if (status==='ignored') add('decision',router,'判断无需办理','No action needed');
  else if (status==='merged') add('merge',router,'判断为已有事项的补充，已并入','Merged into an earlier request as a follow-up',
    run.mergedTitle && tr('并入：','Merged into: ')+run.mergedTitle);
  else {
    if (run.role) {
      add('decision',router,'决定办理','Accepted for work');
      const role=spaceRoleLabel(run.role,tr,run.roleName);
      const where=run.targetWorkspaceId && tr('工作区：','Workspace: ')+(run.targetWorkspaceTitle || run.targetWorkspaceId);
      const preset=run.presetId && tr('指定预设：','Requested preset: ')+run.presetId;
      add('assignment',router,'指派给'+role,'Assigned to '+role,
        [preset,where].filter(Boolean).join(tr('；','; ')) || undefined);
    }
    // Follow-up messages merged into this request, waiting for its worker.
    if (run.supplements?.length) add('merge',router,'并入 '+run.supplements.length+' 条补充消息，助手将据此继续',
      'Merged '+run.supplements.length+' follow-up message(s); the worker continues with them');
    // The worker checks its own result; there is no separate review step.
    const done=['approved','awaiting-release','declined','delivering','delivered'].includes(status) || !!run.answer;
    if (question) add('worker',worker,'已提出追问','Clarifying question prepared');
    else if (done) add('worker',worker,'已完成办理','Work completed');
    else if (status==='working') add('worker',worker,'正在办理','Working');

    if (status==='awaiting-release') add('release',tr('你','You'),question?'等待你确认发送追问':'等待你确认发送最终答复',question?'Awaiting your confirmation to send the question':'Awaiting your confirmation to send the final reply');
    else if (status==='declined') add('release',tr('你','You'),'已选择不发送','Chose not to send');
    else if (status==='delivering') add('delivery',channel,'正在回复原消息','Replying to the original message');
    else if (status==='waiting-requester' && run.receipt?.messageId) add('delivery',channel,'追问已发送，等待原提需人回复','Question sent; waiting for the original requester');
    else if (status==='delivered' && run.receipt?.messageId) add('delivery',channel,'已回复原消息','Reply delivered');
    else if (['delivered','waiting-requester'].includes(status) || reason==='delivery-uncertain') add('unknown',channel,'送达结果未确认','Delivery unconfirmed');
    else if (reason==='delivery-denied') add('stop',system,'已停止，未发送回复','Stopped without sending a reply');
    else if (reason==='work-uncertain') add('unknown',worker,'助手办理结果未确认','Work outcome unconfirmed');
    else if (status==='taken-over') add('takeover',tr('你','You'),'已接手，SuperAgent 不再办理或发送','Taken over; SuperAgent no longer works on or posts it');
    else if (status==='stopped') {
      const causes={
        'decision-failed':['未能完成判断','Assessment failed'],'invalid-decision':['判断结果无效','Invalid assessment'],
        'work-failed':['未能完成办理','Work could not be completed'],'no-final-answer':['没有可发送的答复','No reply available to send'],
        // Reasons kept for records from the removed review stage.
        'review-stopped':['验收决定停止办理','Review ended the work'],'review-failed':['未能完成验收','Review failed'],
        'invalid-review':['验收结果无效','Invalid review'],'rework-limit':['返工后仍未通过验收','Revision did not pass review'],
        'access-denied':['未能核实当前授权','Current authorization could not be verified'],interrupted:['办理中断','Processing interrupted']
      };
      add('stop',system,'已停止办理','Processing stopped',Object.hasOwn(causes,reason) && tr(...causes[reason]));
    } else if (!['assigned','working','approved'].includes(status)) add('unknown',system,'办理状态未确认','Work status unconfirmed');
  }
  return steps;
}
