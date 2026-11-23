def get_lr(step, peak, warmup_steps):
    return peak * (step // warmup_steps)
