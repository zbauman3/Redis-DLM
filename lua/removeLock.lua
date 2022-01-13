if redis.call("get", KEYS[1]) == ARGV[1] then
	redis.pcall("del", KEYS[1])
	return redis.status_reply("Deleted")
else
	return redis.status_reply("Not Deleted")
end