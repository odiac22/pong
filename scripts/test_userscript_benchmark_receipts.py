import ast
import unittest
from pathlib import Path

source=Path(__file__).with_name('benchmark-userscript-30-sites.py').read_text(encoding='utf-8')
tree=ast.parse(source)
function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='receipt_matches_submission')
scope={}
exec(compile(ast.Module(body=[function],type_ignores=[]),'receipt_matcher','exec'),scope)
match=scope['receipt_matches_submission']

class ReceiptTests(unittest.TestCase):
    def test_matching_capture_requires_same_submitted_id_and_recall(self):
        payload={'id':'new','sourceUrl':'https://example.org/watch'}
        state={'mediaCapture':dict(payload,deliveredVideos=1),'recall':{'id':'new'}}
        self.assertTrue(match(state,payload,payload['sourceUrl']))
        state['recall']['id']='old'
        self.assertFalse(match(state,payload,payload['sourceUrl']))

    def test_same_page_old_receipt_does_not_pass(self):
        payload={'id':'new','sourceUrl':'https://example.org/watch'}
        state={'mediaCapture':dict(payload,id='old',deliveredVideos=1),'recall':{'id':'old'}}
        self.assertFalse(match(state,payload,payload['sourceUrl']))
        self.assertFalse(match(state,{},payload['sourceUrl']))

    def test_pending_new_capture_can_be_acknowledged_but_other_page_cannot(self):
        payload={'id':'new','sourceUrl':'https://example.org/watch'}
        state={'mediaCapture':dict(payload,deliveredVideos=0),'recall':{'id':'old'}}
        self.assertTrue(match(state,payload,payload['sourceUrl']))
        self.assertFalse(match(state,payload,'https://example.org/another'))

    def test_listing_capture_matches_selected_watch_link_not_origin_page(self):
        payload={'id':'new','sourceUrl':'https://example.org/watch/one',
                 'targets':[{'url':'https://example.org/watch/one'}]}
        state={'mediaCapture':dict(payload,deliveredVideos=1),'recall':{'id':'new'}}
        self.assertTrue(match(state,payload,'https://example.org/watch/one'))
        self.assertFalse(match(state,payload,'https://example.org/videos'))

if __name__=='__main__': unittest.main()
