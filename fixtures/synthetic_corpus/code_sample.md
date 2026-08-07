# Synthetic Code Sample

This document contains a fictional code snippet used to exercise the ingestion pipeline.

```python
def estimate_duration(task_count: int, tasks_per_day: int) -> float:
    if tasks_per_day <= 0:
        raise ValueError("tasks_per_day must be positive")
    return task_count / tasks_per_day

if __name__ == "__main__":
    result = estimate_duration(100, 10)
    print(f"Estimated duration: {result} days")
```

The function above is illustrative and does not represent production logic. It is generated for pipeline testing only.
