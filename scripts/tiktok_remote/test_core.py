import unittest
import asyncio
from core import Timings, TouchState, InputMailbox, authorized, normalized_roi


class CoreTests(unittest.TestCase):
    def test_auth(self):
        self.assertFalse(authorized('', ''))
        self.assertFalse(authorized('wrong', 'secret'))
        self.assertTrue(authorized('secret', 'secret'))

    def test_touch_lifecycle(self):
        s = TouchState()
        for seq, action, pressure in [(1, 'down', 1), (2, 'move', 1), (3, 'up', 0), (4, 'down', 1), (5, 'cancel', 0)]:
            self.assertEqual(s.accept(dict(seq=seq, action=action, x=.4, y=.6)), (.4, .6, pressure))
        self.assertFalse(s.active)

    def test_reject_invalid_sequence_and_coords_without_mutation(self):
        for extra in [{'seq': True}, {'seq': -1}, {'seq': float('nan')}, {'x': float('nan')}, {'x': 1.1}, {'y': -.1}, {'action': 'shell'}]:
            s = TouchState()
            with self.assertRaises(ValueError):
                s.accept(dict(dict(seq=1, action='down', x=.4, y=.6), **extra))
            self.assertEqual(s.sequence, -1)

    def test_duplicate_down_and_stale_up(self):
        s = TouchState()
        s.accept(dict(seq=1, action='down', x=0, y=0))
        for seq, action in [(2, 'down'), (1, 'up')]:
            with self.assertRaises(ValueError):
                s.accept(dict(seq=seq, action=action, x=0, y=0))
        self.assertTrue(s.active)

    def test_up_without_down(self):
        with self.assertRaises(ValueError):
            TouchState().accept(dict(seq=1, action='up', x=0, y=0))

    def test_bounded_statistics_and_missing_data(self):
        t = Timings()
        self.assertEqual(t.public(), {})
        for i in range(1100):
            t.add('rpc', i)
        t.add('rpc', float('nan'))
        self.assertEqual(t.public()['rpc']['count'], 1000)
        self.assertEqual(t.public()['rpc']['medianMs'], 599)

    def test_roi(self):
        self.assertEqual(normalized_roi([0, .1, 1, .9]), (0, .1, 1, .9))
        with self.assertRaises(ValueError):
            normalized_roi([1, 0, 0, 1])


class InputMailboxTests(unittest.IsolatedAsyncioTestCase):
    async def test_burst_keeps_latest_move_and_all_gesture_boundaries(self):
        q = InputMailbox()
        def event(seq, action):
            return ({'type':'touch', 'seq':seq, 'action':action, 'x':.5, 'y':seq/100}, seq)
        q.put_nowait(event(1, 'down'))
        for i in range(2, 80):
            q.put_nowait(event(i, 'move'))
        q.put_nowait(event(80, 'up'))
        received = [(await q.get())[0]['seq'] for _ in range(3)]
        self.assertEqual(received, [1,79,80])
        self.assertEqual(q.coalesced, 77)

    async def test_coalescing_never_hides_stale_or_malformed_moves(self):
        for change in [{'seq':0}, {'seq':True}, {'x':float('nan')}, {'action':'up'}]:
            q = InputMailbox()
            first = dict(type='touch',seq=1,action='move',x=.5,y=.5)
            q.put_nowait((first,1))
            next_event=dict(first,seq=2);next_event.update(change)
            self.assertIsNone(q.put_nowait((next_event,2)))
            self.assertEqual((await q.get())[1],1)
            self.assertEqual((await q.get())[1],2)

    async def test_full_boundaries_disconnect_instead_of_losing_release(self):
        q = InputMailbox(maxsize=2)
        q.put_nowait(({'type':'key'},1));q.put_nowait(({'type':'key'},2))
        with self.assertRaises(asyncio.QueueFull):
            q.put_nowait(({'type':'key'},3))

    async def test_empty_waiter_wakes_for_new_input(self):
        q = InputMailbox()
        waiting = asyncio.create_task(q.get())
        await asyncio.sleep(0)
        q.put_nowait(({'type':'key'},7))
        self.assertEqual((await asyncio.wait_for(waiting,1))[1],7)


if __name__ == '__main__':
    unittest.main()
