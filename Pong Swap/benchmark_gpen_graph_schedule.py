"""Benchmark added ordering constraints on the unchanged qualified GPEN graph."""
import argparse
import hashlib
import heapq
import json
from pathlib import Path
import statistics
import sys


def constrain_graph(driver, graph, width):
    def check(value):
        if value[0] != driver.CUresult.CUDA_SUCCESS:
            raise RuntimeError(value[0])
        return value[1:]

    handle = driver.CUgraph(graph.raw_cuda_graph())
    _, count = check(driver.cuGraphGetNodes(handle, 0))
    nodes, count = check(driver.cuGraphGetNodes(handle, count))
    _, _, edge_count = check(driver.cuGraphGetEdges(handle, 0))
    sources, targets, edge_count = check(driver.cuGraphGetEdges(handle, edge_count))
    index = {int(node): i for i, node in enumerate(nodes)}
    edges = {(index[int(a)], index[int(b)]) for a, b in zip(sources, targets)}
    degree = [0] * count
    children = [[] for _ in nodes]
    for a, b in edges:
        degree[b] += 1
        children[a].append(b)
    ready = [i for i in range(count) if degree[i] == 0]
    heapq.heapify(ready)
    order = []
    while ready:
        i = heapq.heappop(ready)
        order.append(i)
        for child in children[i]:
            degree[child] -= 1
            if degree[child] == 0:
                heapq.heappush(ready, child)
    if len(order) != count:
        raise RuntimeError('Original graph is not acyclic')
    # This topological chain partition only adds dependencies. It cannot remove
    # original ordering, permit a data race, change an operator, or form a cycle.
    added = [] if not width else [(a, b) for a, b in zip(order, order[width:]) if (a, b) not in edges]
    if added:
        check(driver.cuGraphAddDependencies(handle, [nodes[a] for a, _ in added],
                                           [nodes[b] for _, b in added], len(added)))
    kinds = {}
    for node in nodes:
        kind, = check(driver.cuGraphNodeGetType(node))
        name = str(kind)
        kinds[name] = kinds.get(name, 0) + 1
    return {'nodes': count, 'originalEdges': edge_count, 'addedEdges': len(added), 'nodeTypes': kinds}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    sys.path.insert(0, str(Path(__file__).parent / 'engine' / 'Rope'))
    from rope import _native_dlls  # noqa: F401
    import torch
    import tensorrt as trt
    from cuda.bindings import driver
    torch.cuda.set_device(0)
    plan = Path('E:/Pong Benchmarks/v2904-diner/models/qualified-1024/gpen1024-fp32-notf32-837ad5c891cc4705225f.plan')
    payload = plan.read_bytes()
    runtime = trt.Runtime(trt.Logger(trt.Logger.WARNING))
    engine = runtime.deserialize_cuda_engine(payload)
    stream = torch.cuda.Stream()
    torch.manual_seed(62890)
    image = torch.rand((1, 3, 1024, 1024), dtype=torch.float32, device='cuda') * 2 - 1
    stream.wait_stream(torch.cuda.current_stream())
    result = {'scope': 'Added scheduling edges only; unchanged original FP32/noTF32 plan',
              'planSha256': hashlib.sha256(payload).hexdigest(), 'auxStreams': engine.num_aux_streams,
              'rows': []}
    reference = None
    for width in (0, 1, 2, 4, 8, 0):
        context = engine.create_execution_context()
        output = torch.empty_like(image)
        context.set_tensor_address('input', image.data_ptr())
        context.set_tensor_address('output', output.data_ptr())
        with torch.cuda.stream(stream):
            for _ in range(3):
                if not context.execute_async_v3(stream.cuda_stream):
                    raise RuntimeError('GPEN submission failed')
            stream.synchronize()
            graph = torch.cuda.CUDAGraph(keep_graph=True)
            with torch.cuda.graph(graph, stream=stream, capture_error_mode='thread_local'):
                if not context.execute_async_v3(stream.cuda_stream):
                    raise RuntimeError('GPEN capture failed')
            structure = constrain_graph(driver, graph, width)
            graph.instantiate()
            pairs = []
            for _ in range(24):
                a, b = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
                a.record(stream)
                graph.replay()
                b.record(stream)
                pairs.append((a, b))
            stream.synchronize()
            if reference is None:
                reference = output.clone()
            row = {'chainWidth': width, **structure,
                   'medianMs': statistics.median(a.elapsed_time(b) for a, b in pairs),
                   'bitExact': bool(torch.equal(output, reference)),
                   'maxAbsError': float((output - reference).abs().max().item())}
            result['rows'].append(row)
            print(json.dumps(row), flush=True)
        stream.synchronize()
        del graph, context, output
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
