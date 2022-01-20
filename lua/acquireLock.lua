if redis.call("exists", KEYS[1]) == 1 then
	return redis.error_reply("Exists")
else
	return redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2])
end